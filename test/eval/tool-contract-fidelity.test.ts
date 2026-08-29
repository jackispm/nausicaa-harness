import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGrepTool } from "../../src/tools/index.js";
import { createFrozenWorkspaceFixtureV2Tools } from "./tool-contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("workspace-fixture-v2 tool fidelity", () => {
  it("preserves legacy exactly-at-limit grep truncation without changing production pagination", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nausicaa-frozen-grep-"));
    temporaryDirectories.push(workspace);
    await writeFile(path.join(workspace, "input.txt"), "hit one\nhit two\n", "utf8");
    const arguments_ = { pattern: "hit", limit: 2 };
    const context = { runId: "run-frozen", workspace, operationId: "grep-frozen" };

    const production = await createGrepTool().execute(arguments_, context);
    expect(JSON.parse(production.content)).toMatchObject({
      matchCount: 2,
      truncated: false,
    });

    const frozen = createFrozenWorkspaceFixtureV2Tools({ allowWrite: false })
      .find((tool) => tool.definition.name === "grep")!;
    expect(frozen.definition.description)
      .toBe("Search workspace file contents for a pattern and return bounded structured matches.");
    expect(frozen.definition.parameters.properties).not.toHaveProperty("cursor");

    const result = await frozen.execute(arguments_, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      matchCount: 2,
      truncated: true,
    });
    expect(JSON.parse(result.content)).not.toHaveProperty("nextCursor");
  });
});
