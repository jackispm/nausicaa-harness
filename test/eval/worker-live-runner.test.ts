import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ToolCall,
  TokenUsage,
} from "../../src/domain/index.js";
import { ProviderModelError } from "../../src/model/index.js";
import {
  WORKER_LIVE_MANIFEST,
  WORKER_LIVE_TREATMENT_ARM,
  workerLiveArmOrder,
  workerLivePairOrder,
} from "./worker-live-contract.js";
import { hashJson } from "./fingerprint.js";
import {
  WORKER_LIVE_BUDGET_ENV,
  WORKER_LIVE_EVALUATION_ENV,
  runWorkerLiveEvaluation,
  verifyWorkerLiveArtifacts,
  workerLivePreflight,
  type WorkerLiveModelFactory,
  type WorkerLiveRepositoryState,
} from "./worker-live-runner.js";

const cleanRepository: WorkerLiveRepositoryState = {
  executionCommit: "a".repeat(40),
  clean: true,
  baselineIsAncestor: true,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("Worker live runner", () => {
  it("requires explicit live authorization, key, budget, and clean provenance", () => {
    const base = {
      [WORKER_LIVE_EVALUATION_ENV]: "1",
      OPENROUTER_API_KEY: "test-key",
      [WORKER_LIVE_BUDGET_ENV]: "0.5",
    };
    expect(() => workerLivePreflight(cleanRepository, {})).toThrow(
      WORKER_LIVE_EVALUATION_ENV,
    );
    expect(() => workerLivePreflight(cleanRepository, {
      [WORKER_LIVE_EVALUATION_ENV]: "1",
    })).toThrow(/OPENROUTER_API_KEY/u);
    expect(() => workerLivePreflight(cleanRepository, {
      [WORKER_LIVE_EVALUATION_ENV]: "1",
      OPENROUTER_API_KEY: "test-key",
    })).toThrow(WORKER_LIVE_BUDGET_ENV);
    expect(() => workerLivePreflight(cleanRepository, {
      ...base,
      [WORKER_LIVE_BUDGET_ENV]: "0",
    })).toThrow(/positive finite/u);
    expect(() => workerLivePreflight({
      ...cleanRepository,
      clean: false,
    }, base)).toThrow(/clean worktree/u);
    expect(() => workerLivePreflight({
      ...cleanRepository,
      baselineIsAncestor: false,
    }, base)).toThrow(/not an ancestor/u);
    expect(workerLivePreflight(cleanRepository, base)).toBe(0.5);
  });

  it("counts every physical retry and successful cache/cost usage", async () => {
    const root = await temporaryRoot();
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory: join(root, "artifacts"),
      repositoryStateForTests: cleanRepository,
      modelFactory: retryOnceFactory(),
    });

    expect(evaluation.records).toHaveLength(2);
    for (const record of evaluation.records) {
      expect(record.outcome).toMatchObject({
        completed: true,
        requestCount: 2,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        costUsd: 0.002,
      });
      expect(record.requestIntervals.map((interval) => interval.terminal))
        .toEqual(["failed", "completed"]);
      expect(new Set(record.requestIntervals.map((interval) => (
        interval.logicalRequestId
      ))).size).toBe(1);
      expect(record.requestIntervals.every((interval) => (
        interval.maxOutputTokens > 0
        && interval.maxOutputTokens
          <= WORKER_LIVE_MANIFEST.execution.maxOutputTokensPerRequest
      ))).toBe(true);
    }
    await evaluation.cleanup();
  });

  it("charges cache tokens against the per-arm model-token budget", async () => {
    const root = await temporaryRoot();
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      writeArtifacts: false,
      repositoryStateForTests: cleanRepository,
      modelFactory: () => new DirectAnswerModel({
        input: 1,
        output: 1,
        cacheRead: WORKER_LIVE_MANIFEST.arms[0]!.budget.maxModelTokens,
        cacheWrite: 0,
        costUsd: 0.001,
      }),
    });

    for (const record of evaluation.records) {
      expect(record.outcome).toMatchObject({
        completed: false,
        failureKind: "budget",
        budgetBreached: true,
      });
      expect(record.outcome.cacheReadTokens).toBe(
        WORKER_LIVE_MANIFEST.arms[0]!.budget.maxModelTokens,
      );
    }
    await evaluation.cleanup();
  });

  it("uses the real runtime topology and only records legal joined Worker use", async () => {
    const root = await temporaryRoot();
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 2,
      rootDirectory: join(root, "state"),
      writeArtifacts: false,
      repositoryStateForTests: cleanRepository,
      modelFactory: naturalWorkerFactory,
    });
    const decomposable = evaluation.records.filter((record) => (
      record.taskKind === "decomposable"
    ));
    expect(decomposable).toHaveLength(2);
    const control = decomposable.find((record) => record.armId !== WORKER_LIVE_TREATMENT_ARM)!;
    const treatment = decomposable.find((record) => record.armId === WORKER_LIVE_TREATMENT_ARM)!;
    expect(control.outcome).toMatchObject({
      completed: true,
      workerUsed: false,
      workerRequestCount: 0,
    });
    expect(treatment.outcome).toMatchObject({
      completed: true,
      workerUsed: true,
      overlapped: true,
    });
    expect(treatment.graph).toMatchObject({
      taskCount: 1,
      joined: 1,
      delegated: 0,
      terminal: 0,
      stale: 0,
      anomalyCount: 0,
    });
    expect(treatment.outcome.overlapMs).toBeGreaterThan(0);
    await evaluation.cleanup();
  });

  it("writes one paired partial probe without a report or decision", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: directFactory,
    });
    expect(evaluation.rows).toHaveLength(1);
    expect(evaluation.report).toBeUndefined();
    expect(evaluation.decision).toBeUndefined();
    await expect(readFile(join(artifactDirectory, "report.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: false,
      recordCount: 2,
      sampleCount: 1,
    });
    await evaluation.cleanup();
  });

  it("keeps completed checkpoints when a later arm fails", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    let factoryCall = 0;
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: () => {
        factoryCall += 1;
        return factoryCall === 1
          ? new DirectAnswerModel()
          : new ThrowingModel(new Error("later arm failed"));
      },
    });
    const checkpoint = JSON.parse(await readFile(
      join(artifactDirectory, "raw", "records.json"),
      "utf8",
    )) as { records: Array<{ outcome: { completed: boolean } }> };
    expect(checkpoint.records).toHaveLength(2);
    expect(checkpoint.records.map((record) => record.outcome.completed))
      .toEqual([true, false]);
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: false,
      recordCount: 2,
      failureCount: 1,
    });
    await evaluation.cleanup();
  });

  it("preserves deadline evidence and reports an incomplete probe", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      deadlineMs: 20,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: () => new AbortOnlyModel(),
    });
    expect(evaluation.records.length).toBeGreaterThan(0);
    expect(evaluation.records.length).toBeLessThan(
      WORKER_LIVE_MANIFEST.sampleCount * 2,
    );
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: false,
      recordCount: evaluation.records.length,
    });
    await evaluation.cleanup();
  });

  it("rejects TaskGraph tampering even when the outer digest is recomputed", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: directFactory,
    });
    const checkpointPath = join(artifactDirectory, "raw", "records.json");
    const checkpoint = await readCheckpoint(checkpointPath);
    checkpoint.records[0]!.graph.anomalyCount += 1;
    await writeResignedCheckpoint(checkpointPath, checkpoint);
    await expect(verifyWorkerLiveArtifacts(artifactDirectory))
      .rejects.toThrow(/TaskGraph evidence/u);
    await evaluation.cleanup();
  });

  it("rejects final-text tampering after the checkpoint is re-signed", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: directFactory,
    });
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: false,
      recordCount: 2,
    });

    const checkpointPath = join(artifactDirectory, "raw", "records.json");
    const checkpoint = await readCheckpoint(checkpointPath);
    checkpoint.records[0]!.finalText += " forged conclusion";
    await writeResignedCheckpoint(checkpointPath, checkpoint);

    await expect(verifyWorkerLiveArtifacts(artifactDirectory))
      .rejects.toThrow(/final text|answer artifact/u);
    await evaluation.cleanup();
  });

  it("rejects tool-argument tampering after the checkpoint is re-signed", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: readThenAnswerFactory,
    });
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: false,
      recordCount: 2,
    });

    const checkpointPath = join(artifactDirectory, "raw", "records.json");
    const checkpoint = await readCheckpoint(checkpointPath);
    const record = checkpoint.records.find((candidate) => candidate.toolTrace.length > 0)!;
    record.toolTrace[0]!.arguments.path = "forged/path.md";
    await writeResignedCheckpoint(checkpointPath, checkpoint);

    await expect(verifyWorkerLiveArtifacts(artifactDirectory))
      .rejects.toThrow(/tool trace arguments/u);
    await evaluation.cleanup();
  });

  it("rejects request-session tampering after the checkpoint is re-signed", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: directFactory,
    });
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: false,
      recordCount: 2,
    });

    const checkpointPath = join(artifactDirectory, "raw", "records.json");
    const checkpoint = await readCheckpoint(checkpointPath);
    checkpoint.records[0]!.requestIntervals[0]!.sessionId += ":forged";
    await writeResignedCheckpoint(checkpointPath, checkpoint);

    await expect(verifyWorkerLiveArtifacts(artifactDirectory))
      .rejects.toThrow(/model\/session\/terminal/u);
    await evaluation.cleanup();
  });

  it("rejects per-request output-limit tampering after the checkpoint is re-signed", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      maxPairs: 1,
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: directFactory,
    });
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: false,
      recordCount: 2,
    });

    const checkpointPath = join(artifactDirectory, "raw", "records.json");
    const checkpoint = await readCheckpoint(checkpointPath);
    checkpoint.records[0]!.requestIntervals[0]!.maxOutputTokens =
      WORKER_LIVE_MANIFEST.execution.maxOutputTokensPerRequest + 1;
    await writeResignedCheckpoint(checkpointPath, checkpoint);

    await expect(verifyWorkerLiveArtifacts(artifactDirectory))
      .rejects.toThrow(/request interval is malformed/u);
    await evaluation.cleanup();
  });

  it("completes and independently verifies a full offline fake run", async () => {
    const root = await temporaryRoot();
    const artifactDirectory = join(root, "artifacts");
    const evaluation = await runWorkerLiveEvaluation({
      rootDirectory: join(root, "state"),
      artifactDirectory,
      repositoryStateForTests: cleanRepository,
      modelFactory: directFactory,
    });
    expect(evaluation.rows).toHaveLength(WORKER_LIVE_MANIFEST.sampleCount);
    expect(evaluation.report).toBeDefined();
    expect(evaluation.decision).toBeDefined();
    await expect(verifyWorkerLiveArtifacts(artifactDirectory)).resolves.toMatchObject({
      complete: true,
      recordCount: WORKER_LIVE_MANIFEST.sampleCount * 2,
      sampleCount: WORKER_LIVE_MANIFEST.sampleCount,
      decision: { status: "hold" },
    });

    const checkpointPath = join(artifactDirectory, "raw", "records.json");
    const checkpoint = await readCheckpoint(checkpointPath);
    checkpoint.repository.clean = false;
    await writeResignedCheckpoint(checkpointPath, checkpoint);
    const reportPath = join(artifactDirectory, "report.json");
    const envelope = JSON.parse(await readFile(reportPath, "utf8")) as {
      evidenceDigest: string;
      [key: string]: unknown;
    };
    envelope.evidenceDigest = checkpoint.evidenceDigest;
    await writeFile(reportPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    await expect(verifyWorkerLiveArtifacts(artifactDirectory))
      .rejects.toThrow(/dirty or non-ancestor provenance/u);
    await evaluation.cleanup();
  }, 120_000);

  it("uses the frozen balanced arm order for every pair", () => {
    const pairs = workerLivePairOrder();
    const first = pairs.map((_, index) => (
      workerLiveArmOrder(WORKER_LIVE_MANIFEST, index)[0]!.id
    ));
    expect(first.filter((arm) => arm === "main-only")).toHaveLength(first.length / 2);
    expect(first.filter((arm) => arm === "main-worker")).toHaveLength(first.length / 2);
  });
});

const directFactory: WorkerLiveModelFactory = () => new DirectAnswerModel();

const readThenAnswerFactory: WorkerLiveModelFactory = ({ fixture }) => ({
  async complete(request) {
    if (!hasToolCall(request, "read_file")) {
      return response("", [toolCall("read-evidence", "read_file", {
        path: firstEvidencePath(fixture.task.taskId),
      })]);
    }
    return response(answerFor(request));
  },
});

class DirectAnswerModel implements ModelPort {
  constructor(private readonly usage: TokenUsage = defaultUsage()) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return response(answerFor(request), [], this.usage);
  }
}

class ThrowingModel implements ModelPort {
  constructor(private readonly error: Error) {}

  async complete(): Promise<ModelResponse> {
    throw this.error;
  }
}

class AbortOnlyModel implements ModelPort {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    await new Promise<void>((_resolve, reject) => {
      if (request.signal?.aborted) {
        reject(request.signal.reason);
        return;
      }
      request.signal?.addEventListener(
        "abort",
        () => reject(request.signal?.reason),
        { once: true },
      );
    });
    throw new Error("unreachable");
  }
}

function retryOnceFactory(): WorkerLiveModelFactory {
  return () => {
    let attempts = 0;
    return {
      async complete(request) {
        attempts += 1;
        if (attempts === 1) {
          throw new ProviderModelError({ category: "transient", retryable: true });
        }
        return response(answerFor(request), [], {
          input: 10,
          output: 5,
          cacheRead: 3,
          cacheWrite: 2,
          costUsd: 0.002,
        });
      },
    };
  };
}

const naturalWorkerFactory: WorkerLiveModelFactory = ({ fixture, arm }) => {
  let callId = 0;
  return {
    async complete(request) {
      callId += 1;
      if (request.laneId === "worker") {
        await abortableDelay(25, request.signal);
        return response("Worker evidence synthesis complete.");
      }
      const canDelegate = request.tools.some((tool) => tool.name === "delegate_task");
      if (fixture.task.kind === "decomposable" && arm.workerEnabled && canDelegate) {
        const delegated = hasToolCall(request, "delegate_task");
        const terminalNotice = request.messages.some((message) => (
          message.role === "user" && message.content.includes("Worker task ")
        ));
        if (!delegated) {
          return response("", [toolCall(`delegate-${callId}`, "delegate_task", {
            taskId: "evidence-synthesis",
            statement: "Synthesize the bounded evidence supplied by Main",
            successCriteria: ["Return one grounded summary"],
            hardConstraints: ["Do not invent facts"],
            input: fixture.message,
            maxModelTokens: 500,
            maxWallClockMs: 5_000,
            maxAttempts: 1,
          })]);
        }
        if (!terminalNotice) {
          // Worker startup crosses a committed Main-step boundary and may
          // spend time rebuilding Inbox/Ledger state before its provider
          // request begins. Keep a generous observation window so this
          // deterministic fixture proves overlap rather than scheduler
          // startup latency.
          await abortableDelay(250, request.signal);
          return response("", [toolCall(`read-${callId}`, "read_file", {
            path: firstEvidencePath(fixture.task.taskId),
          })]);
        }
      }
      return response(answerFor(request));
    },
  };
};

function response(
  content: string,
  toolCalls: ToolCall[] = [],
  usage: TokenUsage = defaultUsage(),
): ModelResponse {
  return { content, toolCalls, stopReason: "stop", usage: { ...usage } };
}

function toolCall(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): ToolCall {
  return { id, name, arguments: arguments_ };
}

function defaultUsage(): TokenUsage {
  return { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.001 };
}

function answerFor(request: ModelRequest): string {
  const prompt = request.messages.find((message) => message.role === "user")?.content ?? "";
  if (prompt.includes("runtime requirements")) {
    return "Node.js 22.19 or newer, evergreen browsers, npm, and npm run build:web; policy/ops evidence says the report is local-only.";
  }
  if (prompt.includes("checkout incident")) {
    return "The payment service first failed at 2026-08-27T09:14:03Z because PAYMENT_REGION was missing; the gateway then timed out. Restore the validated region and restart only the payment service.";
  }
  if (prompt.includes("accounts migration")) {
    return "Migration 042 adds the locale column and requires release 3.8. It is not ready because rollback marker accounts-pre-042 is absent; create the backup marker first.";
  }
  return "Local run artifacts are retained for 30 days (policy/retention.md).";
}

function hasToolCall(request: ModelRequest, name: string): boolean {
  return request.messages.some((message) => (
    message.role === "assistant"
    && message.toolCalls.some((call) => call.name === name)
  ));
}

function firstEvidencePath(taskId: string): string {
  switch (taskId) {
    case "runtime-readiness":
      return "services/api/runtime.md";
    case "incident-triage":
      return "logs/payment.log";
    case "migration-review":
      return "db/042_accounts.sql";
    default:
      return "policy/retention.md";
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      rejectDelay(signal.reason);
    }, { once: true });
  });
}

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nausicaa-worker-live-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface MutableWorkerLiveCheckpoint {
  evidenceDigest: string;
  repository: {
    executionCommit: string;
    clean: boolean;
    baselineIsAncestor: boolean;
  };
  records: Array<{
    finalText: string;
    graph: { anomalyCount: number };
    requestIntervals: Array<{ sessionId: string; maxOutputTokens: number }>;
    toolTrace: Array<{ arguments: Record<string, unknown> }>;
  }>;
  [key: string]: unknown;
}

async function readCheckpoint(path: string): Promise<MutableWorkerLiveCheckpoint> {
  return JSON.parse(await readFile(path, "utf8")) as MutableWorkerLiveCheckpoint;
}

async function writeResignedCheckpoint(
  path: string,
  checkpoint: MutableWorkerLiveCheckpoint,
): Promise<void> {
  const { evidenceDigest: _ignored, ...evidence } = checkpoint;
  checkpoint.evidenceDigest = hashJson(evidence);
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}
