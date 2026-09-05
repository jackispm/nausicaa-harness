import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APPLY_PATCH_MOWE_METADATA,
  createApplyPatchTool,
} from "../../src/tools/apply-patch.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, {
    recursive: true,
    force: true,
  })));
});

describe("apply_patch tool", () => {
  it("applies Add, Update, and Delete operations in one deterministic plan", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-");
    await writeFile(path.join(workspace, "existing.txt"), "before\n", "utf8");
    await writeFile(path.join(workspace, "remove.txt"), "remove\n", "utf8");

    const result = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n"
        + "*** Add File: added.txt\n"
        + "+hello\n"
        + "*** Update File: existing.txt\n"
        + "@@\n"
        + "-before\n"
        + "+after\n"
        + "*** Delete File: remove.txt\n"
        + "*** End Patch\n",
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      ok: true,
      status: "applied",
      atomic: false,
      changes: [
        { path: "added.txt", operation: "add", byteLength: 6 },
        { path: "existing.txt", operation: "update", byteLength: 6 },
        { path: "remove.txt", operation: "delete", byteLength: 0 },
      ],
    });
    await expect(readFile(path.join(workspace, "added.txt"), "utf8")).resolves.toBe("hello\n");
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("after\n");
    await expect(lstat(path.join(workspace, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports multiple hunks while preserving BOM and CRLF", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-hunks-");
    await writeFile(path.join(workspace, "file.txt"), "\uFEFFone\r\ntwo\r\nthree\r\n", "utf8");

    const result = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n"
        + "*** Update File: file.txt\n"
        + "@@\n"
        + "-one\n"
        + "+ONE\n"
        + "@@ two\n"
        + "-three\n"
        + "+THREE\n"
        + "*** End Patch",
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    await expect(readFile(path.join(workspace, "file.txt"), "utf8"))
      .resolves.toBe("\uFEFFONE\r\ntwo\r\nTHREE\r\n");
  });

  it("supports pure deletion and EOF insertion hunks", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-insert-");
    await writeFile(path.join(workspace, "file.txt"), "one\ntwo\n", "utf8");
    const result = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n"
        + "*** Update File: file.txt\n"
        + "@@\n"
        + "-two\n"
        + "@@\n"
        + "+three\n"
        + "*** End Patch",
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    await expect(readFile(path.join(workspace, "file.txt"), "utf8")).resolves.toBe("one\nthree\n");
  });

  it("handles deleting the final line of a file without a trailing newline", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-eof-");
    await writeFile(path.join(workspace, "file.txt"), "one\ntwo", "utf8");
    const result = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n*** Update File: file.txt\n@@\n-two\n*** End Patch",
    }, toolContext(workspace));

    expect(result.isError).toBe(false);
    await expect(readFile(path.join(workspace, "file.txt"), "utf8")).resolves.toBe("one\n");
  });

  it("rejects malformed patches and leaves every target untouched", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-malformed-");
    const file = path.join(workspace, "file.txt");
    await writeFile(file, "same\n", "utf8");

    const result = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n*** Update File: file.txt\n@@\n-invalid\n+new\n*** End Patch",
    }, toolContext(workspace));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ ok: false, status: "failed" });
    await expect(readFile(file, "utf8")).resolves.toBe("same\n");
    await expect(lstat(path.join(workspace, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const badAdd = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n*** Add File: bad.txt\nnot-prefixed\n*** End Patch",
    }, toolContext(workspace));
    expect(badAdd.isError).toBe(true);
    const badHeader = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n*** Rename File: old.txt\n*** End Patch",
    }, toolContext(workspace));
    expect(badHeader.isError).toBe(true);
  });

  it("preflights every operation before publishing any file", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-preflight-");
    await writeFile(path.join(workspace, "existing.txt"), "same\n", "utf8");

    const result = await createApplyPatchTool().execute({
      patch: "*** Begin Patch\n"
        + "*** Add File: would-not-land.txt\n"
        + "+created\n"
        + "*** Update File: existing.txt\n"
        + "@@\n"
        + "-wrong\n"
        + "+changed\n"
        + "*** End Patch",
    }, toolContext(workspace));

    expect(result.isError).toBe(true);
    await expect(lstat(path.join(workspace, "would-not-land.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(workspace, "existing.txt"), "utf8")).resolves.toBe("same\n");
  });

  it("enforces duplicate, missing-context, and path-boundary failures", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-boundary-");
    await writeFile(path.join(workspace, "file.txt"), "same\n", "utf8");
    const tool = createApplyPatchTool();
    const context = toolContext(workspace);

    const duplicate = await tool.execute({
      patch: "*** Begin Patch\n*** Add File: file.txt\n+x\n*** Add File: file.txt\n+y\n*** End Patch",
    }, context);
    expect(duplicate.isError).toBe(true);

    const missing = await tool.execute({
      patch: "*** Begin Patch\n*** Update File: file.txt\n@@\n-missing\n+new\n*** End Patch",
    }, context);
    expect(missing.isError).toBe(true);
    await expect(readFile(path.join(workspace, "file.txt"), "utf8")).resolves.toBe("same\n");

    const escape = await tool.execute({
      patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch",
    }, context);
    expect(escape.isError).toBe(true);

    const absolute = await tool.execute({
      patch: "*** Begin Patch\n*** Add File: /tmp/outside.txt\n+x\n*** End Patch",
    }, context);
    expect(absolute.isError).toBe(true);

    const nul = await tool.execute({
      patch: "*** Begin Patch\n*** Add File: bad\0name.txt\n+x\n*** End Patch",
    }, context);
    expect(nul.isError).toBe(true);

    const protectedPath = await tool.execute({
      patch: "*** Begin Patch\n*** Add File: .env\n+x\n*** End Patch",
    }, context);
    expect(protectedPath.isError).toBe(true);
  });

  it("rejects symlink targets, oversized patches, and cancelled calls", async () => {
    const workspace = await temporaryDirectory("nausicaa-apply-patch-limits-");
    const outside = await temporaryDirectory("nausicaa-apply-patch-outside-");
    await writeFile(path.join(outside, "target.txt"), "outside\n", "utf8");
    await symlink(path.join(outside, "target.txt"), path.join(workspace, "link.txt"));
    const tool = createApplyPatchTool();

    const symlinkResult = await tool.execute({
      patch: "*** Begin Patch\n*** Update File: link.txt\n@@\n-outside\n+changed\n*** End Patch",
    }, toolContext(workspace));
    expect(symlinkResult.isError).toBe(true);
    await expect(readFile(path.join(outside, "target.txt"), "utf8")).resolves.toBe("outside\n");

    const oversized = await tool.execute({
      patch: `*** Begin Patch\n*** Add File: huge.txt\n+${"x".repeat(1024 * 1024)}\n*** End Patch`,
    }, toolContext(workspace));
    expect(oversized.isError).toBe(true);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const cancelled = await tool.execute({
      patch: "*** Begin Patch\n*** Add File: cancelled.txt\n+x\n*** End Patch",
    }, { ...toolContext(workspace), signal: controller.signal });
    expect(cancelled.isError).toBe(true);
    await expect(lstat(path.join(workspace, "cancelled.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes explicit workspace write metadata", () => {
    const tool = createApplyPatchTool();
    expect((tool as typeof tool & { metadata: unknown }).metadata).toEqual(APPLY_PATCH_MOWE_METADATA);
    expect(APPLY_PATCH_MOWE_METADATA).toMatchObject({
      effect: "write",
      scope: "workspace",
      supportsBatch: false,
      concurrencySafe: false,
    });
  });
});

function toolContext(workspace: string) {
  return { runId: "run-1", workspace, operationId: "operation-1" };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  workspaces.push(workspace);
  return workspace;
}
