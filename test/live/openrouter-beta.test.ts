import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { projectRunMetrics } from "../../src/observability/index.js";
import { executeRun } from "../../src/runtime/index.js";
import {
  BETA_MAX_REQUESTS,
  BETA_MAX_OUTPUT_TOKENS,
  BETA_MODEL_SELECTOR,
  BETA_SOFT_BUDGET_USD,
  BETA_WALL_CLOCK_TIMEOUT_MS,
  BetaBudgetMeter,
  CappedBetaModel,
  betaArtifactPathIsScoped,
  betaSmokeArtifact,
  betaSmokePreflight,
  classifyBetaFailure,
  inspectBetaRepository,
  publicBetaSmokeSummary,
  readBetaSmokeConfig,
  redactedBetaFailure,
  writeBetaSmokeArtifact,
} from "./openrouter-beta-harness.js";
import { createOpenRouterModelPort } from "../../src/model/index.js";

const config = readBetaSmokeConfig();
const configEligibleForLive = config.liveRequested
  && config.apiKeyConfigured
  && config.model === BETA_MODEL_SELECTOR
  && config.budgetUsd !== undefined
  && Number.isFinite(config.budgetUsd)
  && config.budgetUsd > 0
  && config.budgetUsd <= BETA_SOFT_BUDGET_USD;

describe("OpenRouter beta smoke harness", () => {
  it("preflights without making a provider request when disabled or incomplete", async () => {
    const repository = await inspectBetaRepository();
    const result = betaSmokePreflight(config, repository);
    if (!result.ok) {
      expect(["disabled", "missing-api-key", "missing-model", "invalid-model", "missing-budget", "invalid-budget", "budget-too-large", "dirty-worktree"])
        .toContain(result.code);
    }
  });

  it.skipIf(!configEligibleForLive)("runs one bounded Main tool loop and records a redacted artifact", async () => {
    const repository = await inspectBetaRepository();
    const preflight = betaSmokePreflight(config, repository);
    if (!preflight.ok) {
      // Configuration failures are filtered synchronously above. A dirty
      // worktree is discovered here and must fail closed before any request.
      throw new Error(preflight.message);
    }

    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-live-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(
      join(workspace, "README.md"),
      "Install with npm install. Requires Node >=22.19. Run checks with npm test.\n",
      "utf8",
    );
    const meter = new BetaBudgetMeter(
      preflight.config.budgetUsd!,
      BETA_MAX_REQUESTS,
      BETA_MAX_OUTPUT_TOKENS,
    );
    const model = new CappedBetaModel(createOpenRouterModelPort(), meter);
    const events: import("../../src/domain/index.js").AnyEvent[] = [];
    let status: "pass" | "failed" = "failed";
    const startedAt = Date.now();
    let failureEvidence: import("./openrouter-beta-harness.js").BetaSmokeEvidence | undefined;
    try {
      const result = await executeRun({
        workspace,
        dataDir: join(root, "state"),
        model: BETA_MODEL_SELECTOR,
        message: "Read README.md with the read_file tool, then report the install command, Node requirement, and test command in one short line.",
        goal: {
          version: 1,
          statement: "Report the fixture setup commands from workspace evidence.",
          successCriteria: ["Use read_file evidence before answering"],
          hardConstraints: ["Do not write files"],
        },
        policy: {
          maxMainSteps: 3,
          maxModelTokens: 2_000,
          tetoEnabled: false,
        },
        signal: AbortSignal.timeout(BETA_WALL_CLOCK_TIMEOUT_MS),
      }, {
        mainModel: model,
        createRunId: () => "openrouter-beta-main",
        onEvent: (event) => events.push(event),
      });
      expect(result.completed).toBe(true);
      const runEvents = events.filter((event) => event.runId === result.runId);
      expect(runEvents.some((event) => event.type === "tool.succeeded" && event.payload.name === "read_file"))
        .toBe(true);
      expect(result.finalText).toMatch(/npm install/i);
      expect(result.finalText).toMatch(/22\.19/);
      expect(result.finalText).toMatch(/npm test/i);
      const metrics = projectRunMetrics(events, result.runId);
      expect(metrics.total.modelRequests).toBeGreaterThan(0);
      status = "pass";
    } catch (error: unknown) {
      failureEvidence = classifyBetaFailure(error);
      process.stderr.write(`OpenRouter beta smoke compatibility result: ${redactedBetaFailure(error)}\n`);
      throw error;
    } finally {
      const artifact = betaSmokeArtifact(status, meter, repository.executionCommit, {
        ...(failureEvidence ?? {}),
        elapsedMs: Date.now() - startedAt,
      });
      const artifactPath = await writeBetaSmokeArtifact(artifact);
      expect(betaArtifactPathIsScoped(artifactPath)).toBe(true);
      process.stdout.write(`${publicBetaSmokeSummary(artifact)}\n`);
      await rm(root, { recursive: true, force: true });
    }
  }, BETA_WALL_CLOCK_TIMEOUT_MS + 10_000);
});
