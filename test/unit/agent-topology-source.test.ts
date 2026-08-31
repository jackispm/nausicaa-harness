import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWorkspaceAgentAwareness } from "../../src/cli/agent-topology-source.js";
import { renderAgentTopologyFromSource } from "../../src/cli/agent-topology.js";

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
});

