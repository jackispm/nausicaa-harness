import { describe, expect, it } from "vitest";

import { createOpenRouterModelPort } from "../../src/model/index.js";
import { inspectBetaRepository } from "./openrouter-beta-harness.js";
import {
  betaCapabilityPreflight,
  BETA_CAPABILITY_BATCH_TIMEOUT_MS,
  publicBetaCapabilitySummary,
  readBetaCapabilityConfig,
  runBetaCapabilityBatch,
} from "../eval/beta-capability/runner.js";
import { getBetaCaseManifest } from "../eval/beta-capability/catalog.js";

const config = readBetaCapabilityConfig();
const eligibleForLive = config.liveRequested
  && config.apiKeyConfigured
  && config.model === "openrouter:tencent/hy3"
  && config.modelInput === "openrouter:tencent/hy3"
  && config.cases !== undefined
  && config.cases.length > 0
  && config.cases.length <= 3
  && config.cases.every((id) => getBetaCaseManifest(id).enabledTonight)
  && config.budgetUsd !== undefined
  && Number.isFinite(config.budgetUsd)
  && config.budgetUsd > 0
  && config.budgetUsd <= 0.85
  && config.maxRequests !== undefined
  && Number.isSafeInteger(config.maxRequests)
  && config.maxRequests > 0
  && config.maxRequests <= 5;

describe("OpenRouter beta capability suite", () => {
  it("fails closed before any provider request when the batch is not eligible", async () => {
    const repository = await inspectBetaRepository();
    const preflight = await betaCapabilityPreflight(config, repository);
    if (config.liveRequested && !preflight.ok) throw new Error(preflight.message);
    if (!config.liveRequested) expect(preflight.code).toBe("disabled");
    if (config.liveRequested) expect(preflight.ok).toBe(true);
  });

  it.skipIf(!eligibleForLive)("runs the explicitly selected batch with one shared meter", async () => {
    const result = await runBetaCapabilityBatch({
      config,
      modelFactory: () => createOpenRouterModelPort(),
      writeArtifact: true,
    });
    if (!result.preflight.ok) throw new Error(result.preflight.message);
    expect(result.artifact).toBeDefined();
    expect(result.requestsMade).toBeLessThanOrEqual(config.maxRequests!);
    process.stdout.write(`${publicBetaCapabilitySummary(result.artifact!)}\n`);
  }, (config.deadlineMs ?? BETA_CAPABILITY_BATCH_TIMEOUT_MS) + 15_000);
});
