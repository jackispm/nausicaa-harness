import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentTool } from "../../src/domain/index.js";
import { createOpenRouterModelPort } from "../../src/model/index.js";
import {
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";
import {
  buildCacheProbeArtifact,
  inspectCacheProbeRepository,
  writeCacheProbeArtifact,
} from "../eval/cache-artifact.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const configuredModel = process.env.NAUSICAA_CACHE_EVAL_MODEL
  ?? process.env.NAUSICAA_EVAL_MODEL;
const budgetUsd = Number(
  process.env.NAUSICAA_CACHE_EVAL_BUDGET_USD
    ?? process.env.NAUSICAA_EVAL_BUDGET_USD,
);
const liveEnabled = process.env.NAUSICAA_LIVE_SCENARIO === "legacy"
  && process.env.NAUSICAA_LIVE_TESTS === "1"
  && apiKey !== undefined
  && apiKey.trim().length > 0
  && configuredModel !== undefined
  && configuredModel.trim().length > 0
  && Number.isFinite(budgetUsd)
  && budgetUsd > 0;
const model = configuredModel?.startsWith("openrouter:")
  ? configuredModel
  : `openrouter:${configuredModel ?? "disabled"}`;
const MAX_REQUESTS = 2;
const MAX_OUTPUT_TOKENS = 8;
describe.skipIf(!liveEnabled)("OpenRouter prompt-cache evidence", () => {
  it("reads a stable prefix on the second runtime request and writes reconciled evidence", async () => {
    const port = createOpenRouterModelPort();
    const probeId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), "nausicaa-cache-probe-"));
    const runId = `phase-2.3-cache-probe-${probeId}`;
    const events: SessionRuntimeEvent[] = [];
    const repository = await inspectCacheProbeRepository();
    const startedAt = new Date().toISOString();
    // OpenRouter prompt caching requires a sufficiently large stable prefix.
    // Keep that padding in a probe-only tool description so production tools
    // and the SessionController contract remain unchanged.
    const cachePadding = Array.from({ length: 1_800 }, (_, index) =>
      `cache-policy-${index % 17}: preserve the task objective and use grounded evidence.`,
    ).join("\n");
    const probeTool: AgentTool = {
      definition: {
        name: "cache_probe_noop",
        description: `Probe-only inert tool ${probeId}. ${cachePadding}`,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async () => ({ content: "unused", isError: false }),
    };
    const session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      policy: {
        maxMainStepsPerActivation: 1,
        maxModelTokens: 100_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: port,
      createRunId: () => runId,
      tools: [probeTool],
    });
    session.subscribe((event) => events.push(event));
    try {
      await session.submit({
        inputId: "cache-probe-1",
        text: "Do not call tools. Reply with exactly CACHE_PROBE_OK.",
      });
      await session.waitForIdle();
      await session.submit({
        inputId: "cache-probe-2",
        text: "Do not call tools. Reply with exactly CACHE_PROBE_OK again.",
      });
      await session.waitForIdle();
      const completedAt = new Date().toISOString();
      const durableEvents = events
        .filter((event): event is Extract<SessionRuntimeEvent, { kind: "event" }> =>
          event.kind === "event")
        .map((event) => event.event);
      const artifact = buildCacheProbeArtifact({
        events: durableEvents,
        runId,
        model,
        limits: {
          maxRequests: MAX_REQUESTS,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          budgetUsd,
        },
        provenance: {
          executionCommit: repository.executionCommit,
          repositoryDirty: repository.repositoryDirty,
          startedAt,
          completedAt,
        },
      });
      const evidencePath = join(process.cwd(), ".nausicaa", "evals", "phase-2.3-cache.json");
      await writeCacheProbeArtifact(evidencePath, artifact);
      expect(artifact.releaseDecision).toMatchObject({ status: "pass", eligible: true });
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
