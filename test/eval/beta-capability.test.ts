import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ModelResponse } from "../../src/domain/index.js";
import { ScriptedModel } from "../../src/model/index.js";
import { BETA_CAPABILITY_CATALOG, BETA_CAPABILITY_MANIFEST_HASH, BETA_CAPABILITY_SCORER_HASH, getBetaCaseManifest } from "./beta-capability/catalog.js";
import { createBetaFixture } from "./beta-capability/fixtures.js";
import { gradeBetaCase } from "./beta-capability/graders.js";
import { betaCapabilityPreflight, readBetaCapabilityConfig, runBetaCapabilityBatch, verifyBetaCapabilityArtifact } from "./beta-capability/runner.js";
import { observedReadPathsFromToolResult } from "./beta-capability/trace.js";
import type { BetaCaseId } from "./beta-capability/types.js";
import { BETA_MODEL_SELECTOR } from "../live/openrouter-beta-harness.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 };
const answer = (content = "done", toolCalls: ModelResponse["toolCalls"] = []): ModelResponse => ({ content, toolCalls, stopReason: "stop", usage });
const call = (id: string, name: string, arguments_: Record<string, unknown>): ModelResponse => answer("", [{ id, name, arguments: arguments_ }]);

describe("Beta Capability MiniEval offline contract", () => {
  it("freezes deterministic P0/P1 catalog metadata and attribution", () => {
    expect(BETA_CAPABILITY_CATALOG.map((value) => value.id)).toEqual([
      "compatibility", "bugfix", "resume", "incident-triage", "bash-roundtrip", "file-rewrite", "pi-smoke", "pi-extension", "pi-read-window", "pi-parallel-tools", "pi-edit-disjoint", "pi-find-scope", "pi-bash-tail", "pi-delete-action", "deepseek-fs-cwd", "deepseek-instructions", "multi-agent", "fukai-compaction", "permission-boundary",
    ]);
    expect(BETA_CAPABILITY_MANIFEST_HASH).toBeDefined();
    expect(BETA_CAPABILITY_SCORER_HASH).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(BETA_CAPABILITY_CATALOG.every((value) => value.graderHash === BETA_CAPABILITY_SCORER_HASH)).toBe(true);
    expect(Object.isFrozen(BETA_CAPABILITY_CATALOG[0]?.fixtureFiles)).toBe(true);
    expect(Object.isFrozen(BETA_CAPABILITY_CATALOG[0]?.attribution)).toBe(true);
  });

  it("fails the bug fixture before the agent and grades a real fix", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-bugfix-"));
    try {
      const fixture = await createBetaFixture("bugfix", root);
      const before = await gradeBetaCase(fixture, "", []);
      expect(before.passed).toBe(false);
      await writeFile(join(fixture.workspace, "add.js"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
      const passed = await gradeBetaCase(fixture, "fixed", [
        { laneId: "main", name: "read_file", arguments: { path: "add.js" }, isError: false, observedPaths: ["add.js"] },
        { laneId: "main", name: "edit", arguments: { path: "add.js" }, isError: false },
      ], {
        workspaceCommandSandbox: {
          availability: () => ({ available: true, backend: "macos-seatbelt" }),
          execute: async () => ({
            stdout: { content: "", truncated: false, truncatedBy: null, totalBytes: 0, totalLines: 0, outputBytes: 0, outputLines: 0 },
            stderr: { content: "", truncated: false, truncatedBy: null, totalBytes: 0, totalLines: 0, outputBytes: 0, outputLines: 0 },
            exitCode: 0,
            aborted: false,
            timedOut: false,
          }),
        },
      });
      expect(passed.passed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects changed tests, no-op claims, and boundary escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-grader-"));
    try {
      const fixture = await createBetaFixture("bugfix", root);
      await writeFile(join(fixture.workspace, "add.js"), "export function add(a, b) { return a + b; }\n", "utf8");
      await writeFile(join(fixture.workspace, "add.test.js"), "assert.equal(true, true);\n", "utf8");
      expect((await gradeBetaCase(fixture, "done", [])).passed).toBe(false);
      await writeFile(join(fixture.workspace, "add.test.js"), fixture.initialFiles["add.test.js"]!, "utf8");
      await writeFile(join(fixture.rootDirectory, "outside.txt"), "escape\n", "utf8");
      expect((await gradeBetaCase(fixture, "done", [])).passed).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires explicit cases, model, budget, requests, and clean provenance", async () => {
    const envConfig = readBetaCapabilityConfig({ NAUSICAA_LIVE_TESTS: "1", OPENROUTER_API_KEY: "x" });
    expect((await betaCapabilityPreflight(envConfig)).code).toBe("missing-model");
    const base = readBetaCapabilityConfig({ NAUSICAA_LIVE_TESTS: "1", OPENROUTER_API_KEY: "x", NAUSICAA_BETA_EVAL_MODEL: BETA_MODEL_SELECTOR, NAUSICAA_BETA_CASES: "compatibility,bugfix", NAUSICAA_EVAL_BUDGET_USD: "0.1", NAUSICAA_EVAL_MAX_REQUESTS: "4" });
    expect((await betaCapabilityPreflight(base, { executionCommit: "abc", repositoryDirty: true })).code).toBe("dirty-worktree");
    expect((await betaCapabilityPreflight(base)).ok).toBe(true);
    const overCatalogLimit = Array.from({ length: 101 }, () => "compatibility" as BetaCaseId);
    expect((await betaCapabilityPreflight({ ...base, cases: overCatalogLimit, caseInputs: overCatalogLimit })).code).toBe("too-many-cases");
    expect((await betaCapabilityPreflight({ ...base, cases: ["compatibility", "compatibility"], caseInputs: ["compatibility", "compatibility"] })).code).toBe("invalid-cases");
    const { cases: _baseCases, ...baseWithoutCases } = base;
    expect((await betaCapabilityPreflight({ ...baseWithoutCases, caseInputs: ["future-case"] })).code).toBe("invalid-cases");
    expect((await betaCapabilityPreflight({ ...base, modelInput: "tencent/hy3", model: "tencent/hy3" })).code).toBe("invalid-model");
    expect((await betaCapabilityPreflight({ ...base, budgetUsd: 0.86 })).code).toBe("invalid-budget");
    expect((await betaCapabilityPreflight({ ...base, maxRequests: 101 })).code).toBe("invalid-max-requests");
  });

  it("shares one meter and marks later cases not-run-budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-runner-"));
    try {
      const config = { liveRequested: true, apiKeyConfigured: true, modelInput: BETA_MODEL_SELECTOR, model: BETA_MODEL_SELECTOR, caseInputs: ["compatibility", "bugfix"], cases: ["compatibility", "bugfix"] as const, budgetUsd: 0.01, maxRequests: 1, deadlineMs: 10_000 };
      const model = new ScriptedModel([
        call("read", "read_file", { path: "README.md" }),
      ]);
      const run = await runBetaCapabilityBatch({ config, model, rootDirectory: root, repository: { executionCommit: "abc123", repositoryDirty: false }, writeArtifact: true, artifactCwd: root });
      expect(run.requestsMade).toBe(1);
      expect(run.artifact?.cases[1]?.status).toBe("not-run-budget");
      expect(verifyBetaCapabilityArtifact(run.artifact!)).toEqual(run.artifact);
      expect(() => verifyBetaCapabilityArtifact({ ...run.artifact!, prompt: "secret" })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("stops the batch and reports null cost when a dispatched usage is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-uncertain-"));
    try {
      const config = { liveRequested: true, apiKeyConfigured: true, modelInput: BETA_MODEL_SELECTOR, model: BETA_MODEL_SELECTOR, caseInputs: ["compatibility", "bugfix"] as const, cases: ["compatibility", "bugfix"] as const, budgetUsd: 0.1, maxRequests: 4, deadlineMs: 10_000 };
      const model = new ScriptedModel([
        { content: "", toolCalls: [], stopReason: "stop", usage: undefined as never },
      ]);
      const run = await runBetaCapabilityBatch({ config, model, rootDirectory: root, repository: { executionCommit: "abc123", repositoryDirty: false }, writeArtifact: true, artifactCwd: root });
      expect(run.artifact?.budget.costUsd).toBeNull();
      expect(run.artifact?.cases[0]?.failureCode).toBe("uncertain-cost");
      expect(run.artifact?.cases[1]?.status).toBe("not-run-budget");
      expect(run.artifact?.cases[1]?.failureCode).toBe("uncertain-cost");
      expect(model.callCount).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects unsafe paths and non-exact grade records in artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-artifact-contract-"));
    try {
      const config = { liveRequested: true, apiKeyConfigured: true, modelInput: BETA_MODEL_SELECTOR, model: BETA_MODEL_SELECTOR, caseInputs: ["compatibility"] as const, cases: ["compatibility"] as const, budgetUsd: 0.1, maxRequests: 2, deadlineMs: 10_000 };
      const model = new ScriptedModel([{ content: "npm install Node 22.19 npm test", toolCalls: [], stopReason: "stop", usage }]);
      const run = await runBetaCapabilityBatch({ config, model, rootDirectory: root, repository: { executionCommit: "abc123", repositoryDirty: false } });
      const artifact = run.artifact!;
      expect(() => verifyBetaCapabilityArtifact({
        ...artifact,
        cases: [{ ...artifact.cases[0]!, readPaths: ["../README.md"] }],
      })).toThrow();
      expect(() => verifyBetaCapabilityArtifact({
        ...artifact,
        cases: [{ ...artifact.cases[0]!, grade: { passed: true } }],
      })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects an unknown case before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-resume-"));
    try {
      const config = { liveRequested: true, apiKeyConfigured: true, modelInput: BETA_MODEL_SELECTOR, model: BETA_MODEL_SELECTOR, caseInputs: ["future-case"], budgetUsd: 0.02, maxRequests: 1, deadlineMs: 10_000 };
      const model = new ScriptedModel([]);
      const run = await runBetaCapabilityBatch({ config, model, rootDirectory: root, repository: { executionCommit: "abc123", repositoryDirty: false } });
      expect(run.preflight.code).toBe("invalid-cases");
      expect(run.artifact).toBeUndefined();
      expect(model.callCount).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reports a missing resume boundary instead of a generic runner error", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-resume-boundary-"));
    try {
      const config = {
        liveRequested: true,
        apiKeyConfigured: true,
        modelInput: BETA_MODEL_SELECTOR,
        model: BETA_MODEL_SELECTOR,
        caseInputs: ["resume"],
        cases: ["resume"] as const,
        budgetUsd: 0.02,
        maxRequests: 4,
        deadlineMs: 10_000,
      };
      const run = await runBetaCapabilityBatch({
        config,
        model: new ScriptedModel([answer("completed")]),
        rootDirectory: root,
        repository: { executionCommit: "abc123", repositoryDirty: false },
        writeArtifact: true,
        artifactCwd: root,
      });
      expect(run.artifact?.cases[0]?.failureCode).toBe("resume-boundary-not-reached");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("completes resume across multiple resumable activations and validates its artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-resume-complete-"));
    try {
      const config = {
        liveRequested: true,
        apiKeyConfigured: true,
        modelInput: BETA_MODEL_SELECTOR,
        model: BETA_MODEL_SELECTOR,
        caseInputs: ["resume"],
        cases: ["resume"] as const,
        budgetUsd: 0.02,
        maxRequests: 4,
        deadlineMs: 10_000,
      };
      const model = new ScriptedModel([
        call("write-1", "write_file", { path: "resume.txt", content: "resume-ready\n" }),
        call("read-1", "read_file", { path: "resume.txt" }),
        call("write-2", "write_file", { path: "resume.txt", content: "resume-ready\ncomplete\n" }),
        answer("Final state: resume-ready complete"),
      ]);
      const run = await runBetaCapabilityBatch({
        config,
        model,
        rootDirectory: root,
        repository: { executionCommit: "abc123", repositoryDirty: false },
        writeArtifact: true,
        artifactCwd: root,
      });
      expect(run.artifact?.cases[0]?.status).toBe("pass");
      expect(run.artifact?.cases[0]?.completed).toBe(true);
      expect(run.artifact?.cases[0]?.requestCount).toBe(4);
      expect(verifyBetaCapabilityArtifact(run.artifact!)).toEqual(run.artifact);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records successful path mutations in case telemetry", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-mutation-telemetry-"));
    try {
      const config = {
        liveRequested: true,
        apiKeyConfigured: true,
        modelInput: BETA_MODEL_SELECTOR,
        model: BETA_MODEL_SELECTOR,
        caseInputs: ["pi-delete-action"],
        cases: ["pi-delete-action"] as const,
        budgetUsd: 0.02,
        maxRequests: 3,
        deadlineMs: 10_000,
      };
      const run = await runBetaCapabilityBatch({
        config,
        model: new ScriptedModel([
          call("delete", "path_delete", { path: "temp-threejs-landing.html" }),
          call("verify", "list_files", { path: "." }),
          answer("deleted"),
        ]),
        rootDirectory: root,
        repository: { executionCommit: "abc123", repositoryDirty: false },
        writeArtifact: true,
        artifactCwd: root,
      });
      const result = run.artifact?.cases[0];
      expect(result?.status).toBe("pass");
      expect(result?.mutationTools).toEqual(["path_delete"]);
      expect(result?.tools).toContain("path_delete");
      expect(verifyBetaCapabilityArtifact(run.artifact!)).toEqual(run.artifact);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts a completed resume fact without requiring an extra terminal newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-resume-newline-"));
    try {
      const fixture = await createBetaFixture("resume", root);
      await writeFile(join(fixture.workspace, "resume.txt"), "resume-ready\ncomplete", "utf8");
      const grade = await gradeBetaCase(
        fixture,
        "Final state: resume-ready complete",
        [
          { laneId: "main", name: "read_file", arguments: { path: "resume.txt" }, isError: false, observedPaths: ["resume.txt"] },
          { laneId: "main", name: "edit", arguments: { path: "resume.txt" }, isError: false },
        ],
        { resumed: true },
      );
      expect(grade.passed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("derives read evidence only from successful structured tool results", () => {
    const allowed = new Set(["a.log", "b.log", "c.log"]);
    expect(observedReadPathsFromToolResult(
      "read_many",
      JSON.stringify({ results: [{ path: "a.log", ok: true }, { path: "b.log", ok: false }] }),
      false,
      allowed,
    )).toEqual(["a.log"]);
    expect(observedReadPathsFromToolResult(
      "grep",
      JSON.stringify({ matches: [{ path: "b.log" }], files: ["c.log", "../a.log"] }),
      false,
      allowed,
    )).toEqual(["b.log", "c.log"]);
    expect(observedReadPathsFromToolResult(
      "read_many",
      JSON.stringify({ results: [{ path: "a.log", ok: true }] }),
      true,
      allowed,
    )).toEqual([]);
  });

  it("grades incident triage only from complete read evidence and safe action", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-incident-"));
    try {
      const fixture = await createBetaFixture("incident-triage", root);
      const grade = await gradeBetaCase(
        fixture,
        "The payment service first failed at 09:14:03 because PAYMENT_REGION was missing; the gateway saw an upstream timed out error. Restore the validated regional value and restart only the payment service.",
        ["logs/gateway.log", "logs/payment.log", "config/payment.example", "runbooks/checkout.md"].map((path) => ({ laneId: "main", name: "read_file", arguments: { path: `./${path}` }, isError: false, observedPaths: [path] })),
      );
      expect(grade.passed).toBe(true);
      const equivalentActionGrade = await gradeBetaCase(
        fixture,
        "The payment service failed at 09:14:03 because the payment region was missing; the gateway saw an upstream timed out error. Restore the validated value, then restart the payment service.",
        ["logs/gateway.log", "logs/payment.log", "config/payment.example", "runbooks/checkout.md"].map((path) => ({ laneId: "main", name: "read_file", arguments: { path }, isError: false, observedPaths: [path] })),
      );
      expect(equivalentActionGrade.passed).toBe(true);
      const runbookWarningGrade = await gradeBetaCase(
        fixture,
        "The payment service failed at 09:14:03 because the payment region was missing; the gateway saw an upstream timed out error. Restore the validated value, restart only the payment service, and do not retry captured charges manually.",
        ["logs/gateway.log", "logs/payment.log", "config/payment.example", "runbooks/checkout.md"].map((path) => ({ laneId: "main", name: "read_file", arguments: { path }, isError: false, observedPaths: [path] })),
      );
      expect(runbookWarningGrade.passed).toBe(true);
      const unsafeActionGrade = await gradeBetaCase(
        fixture,
        "Restore the payment region, but do not restart the payment service.",
        ["logs/gateway.log", "logs/payment.log", "config/payment.example", "runbooks/checkout.md"].map((path) => ({ laneId: "main", name: "read_file", arguments: { path }, isError: false, observedPaths: [path] })),
      );
      expect(unsafeActionGrade.passed).toBe(false);
      const batchGrade = await gradeBetaCase(
        fixture,
        "The payment service first failed at 09:14:03 because PAYMENT_REGION was missing; the gateway saw an upstream timed out error. Restore the validated regional value and restart only the payment service.",
        [{
          laneId: "main",
          name: "read_many",
          arguments: {
            targets: ["logs/gateway.log", "logs/payment.log", "config/payment.example", "runbooks/checkout.md"]
              .map((path) => ({ path: `./${path}` })),
          },
          isError: false,
          observedPaths: ["logs/gateway.log", "logs/payment.log", "config/payment.example", "runbooks/checkout.md"],
        }],
      );
      expect(batchGrade.passed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes failed grader assertions as canonical artifact codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-beta-failed-grade-"));
    try {
      const config = {
        liveRequested: true,
        apiKeyConfigured: true,
        modelInput: BETA_MODEL_SELECTOR,
        model: BETA_MODEL_SELECTOR,
        caseInputs: ["incident-triage"],
        cases: ["incident-triage"] as const,
        budgetUsd: 0.02,
        maxRequests: 1,
        deadlineMs: 10_000,
      };
      const run = await runBetaCapabilityBatch({
        config,
        model: new ScriptedModel([answer("insufficient evidence; restart all services")]),
        rootDirectory: root,
        repository: { executionCommit: "abc123", repositoryDirty: false },
        writeArtifact: true,
        artifactCwd: root,
      });
      const result = run.artifact?.cases[0];
      expect(result?.status).toBe("fail");
      expect(result?.grade?.failureCodes).toContain("payment-service");
      expect(result?.grade?.failureCodes).toContain("no-unsafe-action");
      expect(result?.grade?.failureCodes.every((code) => /^[a-z][a-z0-9_-]{0,127}$/u.test(code))).toBe(true);
      expect(verifyBetaCapabilityArtifact(run.artifact!)).toEqual(run.artifact);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when a manifest is tampered", async () => {
    const manifest = { ...structuredClone(getBetaCaseManifest("bugfix")) };
    manifest.task = "changed";
    const { verifyBetaCaseManifest } = await import("./beta-capability/catalog.js");
    expect(() => verifyBetaCaseManifest(manifest)).toThrow(/modified/u);
  });
});
