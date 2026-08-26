import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FROZEN_FIXTURE_CATALOG,
  createEvaluationFixture,
  publicFixtureView,
  scoreFixture,
  validateFixtureCatalog,
} from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("frozen Phase 2.4 fixtures", () => {
  it("keeps the hidden oracle outside the model-facing fixture", async () => {
    const fixture = await materialize("goal-drift-001");
    const publicFixture = publicFixtureView(fixture);

    expect(publicFixture).not.toHaveProperty("oracle");
    expect(publicFixture).not.toHaveProperty("oracleRoot");
    expect(publicFixture).not.toHaveProperty("initialWorkspace");
    expect(JSON.stringify(publicFixture)).not.toContain("requiredAnswerTerms");
  });

  it("awards a perfect coding score only for the exact answer and allowed file", async () => {
    const fixture = await materialize("coding-001");
    await writeFile(
      join(fixture.workspace, "src/slug.ts"),
      "export function slugify(input: string): string {\n  return input.trim().toLowerCase().replaceAll(/\\s+/g, \"-\");\n}\n",
      "utf8",
    );

    await expect(scoreFixture(fixture, "Implemented the requested slug helper.", [
      { name: "read_file", arguments: { path: "OPTIONAL-MISSING.md" }, isError: true },
      ...["STAGE-1.md", "STAGE-2.md", "STAGE-3.md", "STAGE-4.md"].map((path) => ({
        name: "read_file",
        arguments: { path },
        isError: false,
      })),
      { name: "write_file", arguments: { path: "src/slug.ts" }, isError: false },
    ])).resolves.toBe(1);
  });

  it("assigns zero to forbidden tools and unexpected mutations", async () => {
    const forbiddenTool = await materialize("goal-drift-001");
    await expect(scoreFixture(forbiddenTool, "npm install; Node.js >=22.19", [{
      name: "bash",
      arguments: { command: "npm install" },
      isError: false,
    }])).resolves.toBe(0);

    const mutation = await materialize("coding-001");
    await writeFile(join(mutation.workspace, "STAGE-1.md"), "unexpected\n", "utf8");
    await expect(scoreFixture(mutation, "Implemented the requested slug helper.", [])).resolves.toBe(0);
  });

  it("rejects any mutation of the frozen catalog", () => {
    expect(() => validateFixtureCatalog(FROZEN_FIXTURE_CATALOG)).not.toThrow();
    const changed = structuredClone(FROZEN_FIXTURE_CATALOG) as unknown as Array<{
      visibleFiles: Record<string, string>;
    }>;
    changed[0]!.visibleFiles["STAGE-1.md"] = "mutated\n";

    expect(() => validateFixtureCatalog(changed)).toThrow(/frozen content hash/);
  });
});

async function materialize(taskId: string) {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-phase24-fixture-"));
  roots.push(root);
  const task = FROZEN_FIXTURE_CATALOG.find((candidate) => candidate.task.taskId === taskId)?.task;
  if (task === undefined) throw new Error(`Unknown fixture ${taskId}`);
  return createEvaluationFixture(task, root);
}
