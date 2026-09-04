import { describe, expect, it } from "vitest";

import {
  canonicalInteractiveCommandName,
  findInteractiveCommand,
  formatInteractiveCommandHelp,
  PENDING_APPROVAL_COMMANDS,
  PUBLIC_INTERACTIVE_COMMANDS,
} from "../../src/cli/command-registry.js";

describe("interactive command registry", () => {
  it("keeps the public surface canonical and references every compatibility entry", () => {
    expect(PUBLIC_INTERACTIVE_COMMANDS.every((spec) => (
      (spec.visibility === "public" || spec.visibility === "compatibility")
      && spec.alignment !== "pending-approval"
      && spec.references.length > 0
    ))).toBe(true);
    expect(PUBLIC_INTERACTIVE_COMMANDS.map((spec) => spec.name)).toEqual([
      "help",
      "setup",
      "status",
      "login",
      "logout",
      "agents",
      "edges",
      "skills",
      "context",
      "compact",
      "model",
      "permissions",
      "mode",
      "plan",
      "theme",
      "goal",
      "session",
      "tree",
      "fork",
      "new",
      "resume",
      "resolve",
      "copy",
      "stop",
      "quit",
    ]);
  });

  it("canonicalizes established compatibility aliases", () => {
    expect(canonicalInteractiveCommandName("exit")).toBe("quit");
    expect(canonicalInteractiveCommandName("topology")).toBe("agents");
    expect(canonicalInteractiveCommandName("usage")).toBe("context");
    expect(canonicalInteractiveCommandName("cancel")).toBe("stop");
    expect(findInteractiveCommand("/stop")?.name).toBe("stop");
    expect(findInteractiveCommand("/quit")?.name).toBe("quit");
    expect(findInteractiveCommand("/cancel")?.name).toBe("stop");
    expect(findInteractiveCommand("/setup")?.name).toBe("setup");
    expect(findInteractiveCommand("/mode")?.name).toBe("mode");
    expect(canonicalInteractiveCommandName("branch")).toBe("fork");
    expect(findInteractiveCommand("/branch")?.name).toBe("fork");
  });

  it("keeps the pending extension list empty and includes compatibility help", () => {
    const help = formatInteractiveCommandHelp();
    for (const name of PENDING_APPROVAL_COMMANDS) {
      expect(findInteractiveCommand(name)).toBeUndefined();
      expect(help).not.toMatch(new RegExp(String.raw`/${name}(?:\\s|$)`, "u"));
    }
    expect(help).toContain("/setup");
    expect(help).toContain("/edges [refresh]");
    expect(help).toContain("/mode [default|plan]");
    expect(help).toContain("/fork [run-id]");
    expect(help).toContain("/tree");
    expect(help).toContain("/compact");
    expect(help).toContain("/resolve <operation-id>");
    expect(help).toContain("/stop");
    expect(help).toContain("/quit");
  });
});
