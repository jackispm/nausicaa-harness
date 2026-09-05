import { describe, expect, it } from "vitest";

import { diagnosePermissionFailure } from "../../src/tools/permission-diagnostics.js";

describe("permission diagnostics", () => {
  it("classifies Git metadata denials and gives the explicit escalation path", () => {
    expect(diagnosePermissionFailure({
      command: "git commit -m docs",
      stderr: "fatal: unable to create '.git/index.lock': Operation not permitted",
    })).toMatchObject({
      code: "permission-denied",
      scope: "git-metadata",
      hint: expect.stringContaining("git_status/git_log/git_show/git_diff"),
    });
  });

  it("classifies a workspace filesystem denial without leaking the path", () => {
    expect(diagnosePermissionFailure({
      command: "touch generated.txt",
      stderr: "touch: generated.txt: Permission denied",
    })).toEqual({
      code: "permission-denied",
      scope: "filesystem",
      hint: "The current execution boundary denied this filesystem operation. Check the workspace permission or select /permissions full-access for host-level access.",
    });
  });

  it("recognizes an unavailable workspace sandbox error", () => {
    const error = Object.assign(new Error("macOS Seatbelt cannot apply a profile"), {
      code: "WORKSPACE_SANDBOX_UNAVAILABLE",
    });
    expect(diagnosePermissionFailure({ error })).toMatchObject({
      code: "permission-denied",
      scope: "filesystem",
    });
  });
});
