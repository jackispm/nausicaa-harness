import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

import { A2AInbox } from "../../src/a2a/index.js";
import { createNausicaaCredentialStore } from "../../src/auth/index.js";
import type { AnyEvent, ModelRequest } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { createOpenRouterModelPort } from "../../src/model/index.js";
import { isMainPublicEvent } from "../../src/runtime/main-public-projection.js";
import { TetoLaneScheduler } from "../../src/runtime/teto-lane-scheduler.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";
import { TopologyLiveModel } from "./topology-live-model.js";

// Replay actual owner observations into an isolated observer. The source
// Ledger is read as complete JSONL lines; no application tools are executed.
async function main(): Promise<void> {
  if (process.env.NAUSICAA_TETO_RECORDED_LIVE !== "1") throw new Error("Explicit live opt-in is required");
  const sourcePath = resolve(process.argv[2] ?? "");
  const label = process.argv[3] ?? "current";
  if (!/^[a-z-]+$/u.test(label)) throw new Error("Invalid report label");
  const sourceText = await readFile(sourcePath, "utf8");
  const sourceEvents = sourceText.slice(0, sourceText.lastIndexOf("\n")).split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as AnyEvent);
  const created = sourceEvents.find((event) => event.type === "run.created");
  const requested = sourceEvents.find((event) => event.type === "model.requested" && event.laneId === "teto");
  if (created?.type !== "run.created" || requested?.type !== "model.requested") throw new Error("Missing source Run or observer request");
  const observations = sourceEvents.filter((event): event is Extract<AnyEvent, { type: "user.message" }> => event.type === "user.message" && event.laneId === "teto")
    .slice(0, 4).map((event) => sourceEvents.find((source) => source.eventId === event.payload.sourceEventId))
    .filter((event): event is AnyEvent => event !== undefined && isMainPublicEvent(event));
  if (observations.length !== 4) throw new Error("Expected four recorded owner observations");

  const credentials = createNausicaaCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(openrouterProvider());
  const modelName = requested.payload.model;
  const price = models.getModel("openrouter", modelName.replace(/^openrouter:/u, ""))?.cost;
  if (price === undefined) throw new Error("Missing model price");
  const live = new TopologyLiveModel(createOpenRouterModelPort({ models }), {
    budgetUsd: 0.1, maxRequests: 4, maxOutputTokens: 1024, timeoutMs: 120_000,
    inputPrice: Math.max(price.input, price.cacheRead, price.cacheWrite), outputPrice: price.output,
  });
  const ledger = new MemoryLedger();
  const inbox = new A2AInbox({ sink: ledger });
  const store = new MemoryContentAddressedStore();
  const requests: Array<Omit<ModelRequest, "signal">> = [];
  for (const event of observations) {
    if (event.type !== "user.message" && event.type !== "assistant.message") throw new Error("Unexpected observation source");
    const ref = event.payload.messageRef;
    const hash = ref.contentHash.slice("sha256:".length);
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid artifact hash");
    const bytes = await readFile(join(dirname(sourcePath), "store", "objects", hash.slice(0, 2), hash.slice(2)));
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Source artifact integrity mismatch");
    await store.put(bytes, ref.mediaType);
  }
  const scheduler = new TetoLaneScheduler({
    eventSink: ledger, inbox, store, runId: created.runId, workspace: created.payload.workspace,
    goal: created.payload.goal ?? { version: 1, statement: "Handle the current user request", successCriteria: [], hardConstraints: [] },
    policy: created.payload.policy, modelName,
    ...(requested.payload.contextManifest === undefined ? {} : { policyVersion: requested.payload.contextManifest.policyVersion }),
    readWatermark: () => ledger.watermark(),
    model: {
      capabilities: (name) => live.capabilities(name),
      complete(request) {
        const { signal: _signal, ...record } = request;
        requests.push(structuredClone(record));
        return live.complete(request);
      },
    },
  });
  const stages: Array<{ sourceEventId: string; calls: number; outgoingMessages: number; toolCalls: number }> = [];
  try {
    for (const source of observations) {
      const beforeMessages = inbox.snapshot().records.length;
      const beforeCalls = live.calls.length;
      scheduler.observeMainEvent(source);
      await scheduler.drain();
      stages.push({ sourceEventId: source.eventId, calls: live.calls.length - beforeCalls,
        outgoingMessages: inbox.snapshot().records.length - beforeMessages,
        toolCalls: live.calls.slice(beforeCalls).reduce((sum, call) => sum + (call.response?.toolCalls.length ?? 0), 0) });
    }
  } finally {
    await scheduler.stop();
  }
  const reportRoot = resolve(".local");
  await mkdir(reportRoot, { recursive: true });
  const output = await mkdtemp(join(reportRoot, `teto-recorded-${label}-`));
  const replayEvents = await ledger.read();
  const firstRequest = replayEvents.find((event) => event.type === "model.requested");
  const report = {
    label, sourcePath, modelName, sourceRequest: requested,
    sourceMessages: sourceEvents.filter((event) => event.type === "message.sent" && event.payload.message.from === "teto"),
    firstRequest, stages, requests, calls: live.calls, replayEvents,
    failures: scheduler.snapshot().failures, knownCostUsd: live.knownCostUsd, costComplete: !live.uncertain,
    quiet: stages.length === 4 && scheduler.snapshot().failures.length === 0
      && live.calls.every((call) => call.response !== undefined && call.error === undefined)
      && stages.every((stage) => stage.calls > 0 && stage.outgoingMessages === 0 && stage.toolCalls === 0),
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ output, quiet: report.quiet, stages, failures: report.failures, knownCostUsd: report.knownCostUsd })}\n`);
  if (!report.quiet) process.exitCode = 1;
}

await main();
