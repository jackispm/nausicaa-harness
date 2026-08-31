import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWorkspaceAgentAwareness } from "../../src/cli/agent-topology-source.js";
import { renderAgentTopologyFromSource } from "../../src/cli/agent-topology.js";
import { ScriptedModel } from "../../src/model/index.js";
import { executeRun } from "../../src/runtime/index.js";

describe("workspace Awareness source", () => {
  it("returns an empty, printable projection without creating runtime state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-source-"));
    try {
      const source = await readWorkspaceAgentAwareness(
        join(workspace, ".nausicaa"),
        workspace,
        "2026-09-01T12:00:00.000Z",
      );
      expect(source.records).toEqual([]);
      expect(renderAgentTopologyFromSource(source)).toContain("0 nodes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("renders a local Run from the committed workspace Ledger projection", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nausicaa-topology-run-"));
    const dataDir = join(workspace, ".nausicaa");
    try {
      await executeRun({
        workspace,
        dataDir,
        model: "scripted",
        message: "Inspect the local topology",
        policy: { maxMainSteps: 1, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([{
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        }]),
        createRunId: () => "local-awareness-run",
      });

      const source = await readWorkspaceAgentAwareness(dataDir, workspace);
      const output = renderAgentTopologyFromSource(source);

      expect(output).toContain("local-awareness-run/main");
      expect(output).toContain("completed: Inspect the local topology");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
