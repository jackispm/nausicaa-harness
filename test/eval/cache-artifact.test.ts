import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryLedger } from "../../src/ledger/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import {
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";
import {
  buildCacheProbeArtifact,
  digestCacheArtifact,
  verifyCacheProbeArtifact,
  verifyCacheProbeArtifactValue,
  writeCacheProbeArtifact,
  type CacheProbeArtifact,
} from "./cache-artifact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("Phase 2.3 runtime cache artifact", () => {
  it("derives evidence from two real Session/MainLoop Turns", async () => {
    const root = await temporaryRoot();
    const model = new ScriptedModel([
      response(0, 0.01),
      response(60, 0.02),
    ]);
    const runtimeEvents: SessionRuntimeEvent[] = [];
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: "openrouter:test/model",
      maxOutputTokens: 8,
      policy: {
        maxMainStepsPerActivation: 1,
        maxModelTokens: 1_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: model,
      tools: [],
      createRunId: () => "runtime-cache-run",
    });
    session.subscribe((event) => runtimeEvents.push(event));
    try {
      await session.submit({ inputId: "runtime-cache-1", text: "first" });
      await session.waitForIdle();
      await session.submit({ inputId: "runtime-cache-2", text: "second" });
      await session.waitForIdle();
      const artifact = buildCacheProbeArtifact({
        events: runtimeEvents.flatMap((event) =>
          event.kind === "event" ? [event.event] : []),
        runId: "runtime-cache-run",
        model: "openrouter:test/model",
        limits: { maxRequests: 2, maxOutputTokens: 8, budgetUsd: 0.10 },
        provenance: {
          executionCommit: "a".repeat(40),
          repositoryDirty: false,
          startedAt,
          completedAt: new Date(Date.now() + 1_000).toISOString(),
        },
      });

      expect(model.requests).toHaveLength(2);
      expect(new Set(model.requests.map((request) => request.sessionId)))
        .toEqual(new Set(["runtime-cache-run:main"]));
      expect(artifact.releaseDecision).toMatchObject({ status: "pass", eligible: true });
      expect(artifact.cacheEvidence.entries.map((entry) => ({
        prefix: entry.prefixContinuity,
        session: entry.sessionContinuity,
        cacheRead: entry.cacheReadTokens,
      }))).toEqual([
        { prefix: "baseline", session: "baseline", cacheRead: 0 },
        { prefix: "stable", session: "stable", cacheRead: 60 },
      ]);
    } finally {
      await session.close();
    }
  });

  it("replays a privacy-safe Ledger excerpt and verifies its runtime evidence", async () => {
    const artifact = await cacheArtifact(60);
    const verified = verifyCacheProbeArtifactValue(
      JSON.parse(JSON.stringify(artifact)) as unknown,
    );

    expect(verified.releaseDecision).toEqual({
      status: "pass",
      eligible: true,
      reasons: [],
    });
    expect(verified.cacheEvidence.total).toMatchObject({
      requestCount: 2,
      completed: 2,
      prefix: { baseline: 1, stable: 1, stableRate: 1 },
      sessionAffinity: { baseline: 1, stable: 1, stableRate: 1 },
      provider: { readEvidence: 1, cacheReadTokens: 60 },
    });
    expect(verified.ledgerExcerpt.map((event) => event.occurredAt)).toHaveLength(4);
    const serialized = JSON.stringify(verified);
    expect(serialized).not.toContain("PRIVATE_PREFIX");
    expect(serialized).not.toContain("PRIVATE_SESSION");
    expect(serialized).not.toContain("PRIVATE_REQUEST");
    expect(serialized).not.toContain("PRIVATE_RESPONSE");
  });

  it("detects digest tampering and independently reconciles re-signed projections", async () => {
    const artifact = await cacheArtifact(60);
    const changedDigest = structuredClone(artifact);
    changedDigest.cacheEvidence.total.requestCount = 3;
    expect(() => verifyCacheProbeArtifactValue(changedDigest)).toThrow(/digest/);

    const changedProjection = structuredClone(artifact);
    changedProjection.cacheEvidence.total.requestCount = 3;
    resign(changedProjection);
    expect(() => verifyCacheProbeArtifactValue(changedProjection)).toThrow(/projection/);

    const changedDecision = structuredClone(artifact);
    changedDecision.releaseDecision = {
      status: "hold",
      eligible: false,
      reasons: ["invented"],
    };
    resign(changedDecision);
    expect(() => verifyCacheProbeArtifactValue(changedDecision)).toThrow(/decision/);

    const changedTimeline = structuredClone(artifact);
    changedTimeline.provenance.startedAt = "2000-01-01T00:00:00.000Z";
    changedTimeline.provenance.completedAt = "2000-01-01T00:00:01.000Z";
    resign(changedTimeline);
    expect(() => verifyCacheProbeArtifactValue(changedTimeline)).toThrow(/timestamp/);
  });

  it("keeps a valid no-hit sample as hold and exposes deterministic verifier exit codes", async () => {
    const root = await temporaryRoot();
    const releasePath = join(root, "release.json");
    const holdPath = join(root, "hold.json");
    const invalidPath = join(root, "invalid.json");
    const release = await cacheArtifact(60);
    const hold = await cacheArtifact(0);
    expect(hold.releaseDecision).toMatchObject({
      status: "hold",
      eligible: false,
      reasons: [expect.stringMatching(/no provider cache-read evidence/)],
    });
    await writeCacheProbeArtifact(releasePath, release);
    await writeCacheProbeArtifact(holdPath, hold);
    const invalid = structuredClone(release);
    invalid.totals.cacheReadTokens += 1;
    await writeCacheProbeArtifact(invalidPath, invalid);

    await expect(verifyCacheProbeArtifact(releasePath)).resolves.toMatchObject({
      releaseDecision: { eligible: true },
    });
    await expect(runVerifier(releasePath)).resolves.toMatchObject({ code: 0 });
    await expect(runVerifier(holdPath)).resolves.toMatchObject({ code: 2 });
    await expect(runVerifier(invalidPath)).resolves.toMatchObject({ code: 1 });
  });
});

async function cacheArtifact(secondCacheRead: number): Promise<CacheProbeArtifact> {
  const ledger = new MemoryLedger();
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const first = await ledger.append({
    runId: "cache-run",
    laneId: "main",
    type: "model.requested",
    payload: {
      model: "openrouter:test/model",
      requestHash: "PRIVATE_REQUEST_1",
      contextWatermark: 1,
      sessionId: "PRIVATE_SESSION",
      prefixHash: "PRIVATE_PREFIX",
      dependencyRefs: ["PRIVATE_DEPENDENCY"],
      truncations: [],
      contextBuildMs: 2,
    },
    correlationId: "private-correlation-1",
    idempotencyKey: "private-idempotency-1",
  });
  await ledger.append({
    runId: "cache-run",
    laneId: "main",
    type: "model.completed",
    payload: {
      model: "openrouter:test/model",
      responseRef: ref("PRIVATE_RESPONSE_1"),
      stopReason: "stop",
      usage: usage(0, 0.01),
      modelLatencyMs: 10,
      cacheOutcome: "write",
    },
    causationId: first.eventId,
    correlationId: "private-correlation-1",
    idempotencyKey: "private-terminal-1",
  });
  const second = await ledger.append({
    runId: "cache-run",
    laneId: "main",
    type: "model.requested",
    payload: {
      model: "openrouter:test/model",
      requestHash: "PRIVATE_REQUEST_2",
      contextWatermark: 2,
      sessionId: "PRIVATE_SESSION",
      prefixHash: "PRIVATE_PREFIX",
      dependencyRefs: [],
      truncations: [],
      contextBuildMs: 3,
    },
    correlationId: "private-correlation-2",
    idempotencyKey: "private-idempotency-2",
  });
  await ledger.append({
    runId: "cache-run",
    laneId: "main",
    type: "model.completed",
    payload: {
      model: "openrouter:test/model",
      responseRef: ref("PRIVATE_RESPONSE_2"),
      stopReason: "stop",
      usage: usage(secondCacheRead, 0.02),
      modelLatencyMs: 11,
      cacheOutcome: secondCacheRead > 0 ? "hit" : "unknown",
    },
    causationId: second.eventId,
    correlationId: "private-correlation-2",
    idempotencyKey: "private-terminal-2",
  });
  const events = await ledger.read();
  await ledger.close();
  return buildCacheProbeArtifact({
    events,
    runId: "cache-run",
    model: "openrouter:test/model",
    limits: { maxRequests: 2, maxOutputTokens: 8, budgetUsd: 0.10 },
    provenance: {
      executionCommit: "a".repeat(40),
      repositoryDirty: false,
      startedAt,
      completedAt: new Date(Date.now() + 1_000).toISOString(),
    },
  });
}

function ref(id: string) {
  return {
    id,
    contentHash: `sha256:${"b".repeat(64)}`,
    mediaType: "application/json",
    byteLength: 2,
  };
}

function usage(cacheRead: number, costUsd: number) {
  return { input: 100, output: 2, cacheRead, cacheWrite: 0, costUsd };
}

function response(cacheRead: number, costUsd: number) {
  return {
    content: "CACHE_PROBE_OK",
    toolCalls: [],
    stopReason: "stop",
    usage: usage(cacheRead, costUsd),
  };
}

function resign(artifact: CacheProbeArtifact): void {
  const { evidenceDigest: _digest, ...core } = artifact;
  artifact.evidenceDigest = digestCacheArtifact(core);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-cache-artifact-"));
  roots.push(root);
  return root;
}

async function runVerifier(path: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "test/eval/verify-cache-artifact.ts",
      path,
    ], { cwd: process.cwd() });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}
