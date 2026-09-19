import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { discoverSearchFiles } from "../../src/tools/search-files.js";
import { executeRipgrep } from "../../src/tools/ripgrep.js";

vi.mock("../../src/tools/ripgrep.js", () => ({ executeRipgrep: vi.fn() }));

it("rejects incomplete discovery rather than returning unreachable pages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nausicaa-search-discovery-"));
  try {
    vi.mocked(executeRipgrep).mockResolvedValue({
      stdout: Buffer.from("first.txt\0"),
      stderr: "",
      exitCode: null,
      outputTruncated: true,
    });

    await expect(discoverSearchFiles(workspace, ".", "*.txt", {}, undefined))
      .rejects.toThrow(/discovery exceeds the 4 MiB limit.*narrow the search path/u);
  } finally {
    await rm(workspace, { recursive: true });
  }
});
