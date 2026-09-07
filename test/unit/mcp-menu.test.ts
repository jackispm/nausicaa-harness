import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { renderAuthPanel } from "../../src/cli/auth-menu.js";
import type { McpManagement, McpServerSummary } from "../../src/cli/mcp-management.js";
import { McpMenu } from "../../src/cli/mcp-menu.js";

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function create(servers: readonly McpServerSummary[] = [], overrides: Partial<McpManagement> = {}, rows = 24) {
  const controller = {
    list: vi.fn(async () => servers),
    add: vi.fn(async (_input: Parameters<McpManagement["add"]>[0]) => {}),
    setEnabled: vi.fn(async (_name: string, _enabled: boolean) => {}),
    remove: vi.fn(async (_name: string) => {}),
    refresh: vi.fn(async () => {}),
    ...overrides,
  } satisfies McpManagement;
  const onCancel = vi.fn();
  const onChanged = vi.fn();
  const requestRender = vi.fn();
  const menu = new McpMenu({ controller, getRows: () => rows, onCancel, onChanged, requestRender });
  menu.focused = true;
  const text = (width = 78) => stripTerminalSequences(menu.render(width).join("\n"));
  return { menu, controller, text, onCancel, onChanged, requestRender };
}

function field(menu: McpMenu, value: string): void {
  menu.handleInput("\x01");
  menu.handleInput("\x0b");
  menu.handleInput(value);
  menu.handleInput("\r");
}

function add(menu: McpMenu, name = "demo"): void {
  menu.handleInput("add");
  menu.handleInput("\r");
  field(menu, name);
}

function stdio(menu: McpMenu): void {
  add(menu);
  menu.handleInput("\r");
  field(menu, "npx");
  field(menu, '["-y", "example-mcp"]');
}

function http(menu: McpMenu): void {
  add(menu);
  menu.handleInput("\x1b[B");
  menu.handleInput("\r");
  field(menu, "https://example.test/mcp");
}

const userServer = {
  name: "local-tools", transport: "stdio", origin: "user", enabled: true, status: "saved; restart required", toolCount: 0,
} as const satisfies McpServerSummary;

describe("McpMenu", () => {
  it("lists settings without starting refresh or any mutation", async () => {
    const { menu, controller, text } = create([userServer]);
    await settle();
    expect(controller.list).toHaveBeenCalledOnce();
    expect(controller.refresh).not.toHaveBeenCalled();
    expect(controller.add).not.toHaveBeenCalled();
    expect(controller.setEnabled).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
    expect(text()).toContain("local-tools");
    expect(text()).toContain("stdio | user | 0 tools");
    expect(text()).toContain("Add server");
    menu.dispose();
  });

  it("uses server-specific search and empty-result labels", async () => {
    const { menu, text } = create();
    await settle();
    expect(text()).toContain("Search servers");
    menu.handleInput("no-such-server");
    expect(text()).toContain("No matching servers");
    expect(text()).not.toContain("providers");
    menu.dispose();
  });

  it("requires explicit read-only consent before saving stdio configuration", async () => {
    const { menu, controller, text, onChanged } = create();
    await settle();
    stdio(menu);
    expect(text()).toContain("Run program as you?");
    expect(text()).toContain("No process sandbox");
    expect(controller.add).not.toHaveBeenCalled();
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    await settle();
    expect(controller.add).toHaveBeenCalledExactlyOnceWith({
      name: "demo", transport: "stdio", command: "npx", args: ["-y", "example-mcp"], access: "read",
    });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(text()).toContain("saved; restart required");
    expect(controller.refresh).not.toHaveBeenCalled();
    menu.dispose();
  });

  it("defaults trust and full-capability confirmation to Cancel", async () => {
    const { menu, controller, text } = create();
    await settle();
    http(menu);
    menu.handleInput("\r");
    expect(text()).toContain("MCP Servers");
    expect(controller.add).not.toHaveBeenCalled();

    http(menu);
    menu.handleInput("\x1b[B");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    expect(text()).toContain("Allow full capability?");
    menu.handleInput("\r");
    expect(text()).toContain("Connect HTTP endpoint?");
    expect(controller.add).not.toHaveBeenCalled();
    menu.dispose();
  });

  it("saves HTTP configuration only after the extra full-capability confirmation", async () => {
    const { menu, controller, text } = create();
    await settle();
    http(menu);
    menu.handleInput("\x1b[B");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    expect(controller.add).not.toHaveBeenCalled();
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    await settle();
    expect(controller.add).toHaveBeenCalledExactlyOnceWith({
      name: "demo", transport: "http", endpoint: "https://example.test/mcp", access: "full",
    });
    expect(text()).toContain("saved; restart required");
    menu.dispose();
  });

  it("omits endpoint query credentials from the trust panel but preserves the submitted configuration", async () => {
    const { menu, controller, text } = create();
    await settle();
    add(menu);
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    field(menu, "https://example.test/mcp?token=private-query-value");
    expect(text()).toContain("https://example.test/mcp");
    expect(text()).not.toContain("private-query-value");
    expect(text()).not.toContain("?token=");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    await settle();
    expect(controller.add).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://example.test/mcp?token=private-query-value",
    }));
    menu.dispose();
  });

  it("keeps the process trust warning visible on a narrow short terminal", async () => {
    const { menu, text } = create([], {}, 12);
    await settle();
    stdio(menu);
    expect(text(24)).toContain("Run program as you?");
    expect(text(24)).toContain("No process sandbox");
    expect(text(24)).toContain("npx");
    menu.handleInput("\x1b[B");
    expect(text(24)).toContain("Read-only tools");
    expect(text(24)).toContain("No process sandbox");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    expect(text(24)).toContain("No process sandbox");
    expect(menu.render(24).length).toBeLessThanOrEqual(10);
    menu.dispose();
  });

  it("keeps invalid JSON arguments in the form without saving", async () => {
    const { menu, controller, text } = create();
    await settle();
    add(menu);
    menu.handleInput("\r");
    field(menu, "npx");
    field(menu, "not-json");
    expect(text()).toContain("Enter a JSON array of strings.");
    field(menu, '["ok", 5]');
    expect(text()).toContain("at most 256 strings");
    expect(controller.add).not.toHaveBeenCalled();
    field(menu, "[]");
    expect(text()).toContain("Run program as you?");
    menu.dispose();
  });

  it("rejects duplicate names and credential-bearing endpoints", async () => {
    const { menu, controller, text } = create([userServer]);
    await settle();
    add(menu, "local-tools");
    expect(text()).toContain("A server with this name already exists.");
    field(menu, "other");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    field(menu, "ftp://example.test/mcp");
    expect(text()).toContain("Use HTTP or HTTPS without credentials or fragments.");
    field(menu, "https://name:password@example.test/mcp");
    expect(text()).toContain("Use HTTP or HTTPS without credentials or fragments.");
    expect(controller.add).not.toHaveBeenCalled();
    menu.dispose();
  });

  it("returns through wizard steps without losing accepted values", async () => {
    const { menu, text, controller } = create();
    await settle();
    stdio(menu);
    menu.handleInput("\x1b");
    expect(text()).toContain("Arguments (JSON array)");
    expect(text()).toContain("example-mcp");
    menu.handleInput("\x1b");
    expect(text()).toContain("Command");
    expect(text()).toContain("npx");
    menu.handleInput("\x1b");
    expect(text()).toContain("Transport");
    menu.handleInput("\x1b");
    expect(text()).toContain("Server name");
    expect(text()).toContain("demo");
    expect(controller.add).not.toHaveBeenCalled();
    menu.dispose();
  });

  it("does not offer mutation controls for project-owned sources", async () => {
    const { menu, controller, text } = create([{ ...userServer, origin: "project" }]);
    await settle();
    menu.handleInput("\r");
    expect(text()).toContain("Project configuration is read-only here.");
    expect(text()).not.toContain("Disable server");
    expect(text()).not.toContain("Remove server");
    menu.handleInput("\r");
    expect(controller.setEnabled).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
    menu.dispose();
  });

  it("saves enabled-state changes with restart-required feedback", async () => {
    const { menu, controller, text } = create([userServer]);
    await settle();
    menu.handleInput("\r");
    menu.handleInput("\r");
    await settle();
    expect(controller.setEnabled).toHaveBeenCalledExactlyOnceWith("local-tools", false);
    expect(text()).toContain("saved; restart required");
    menu.dispose();
  });

  it("keeps pending restart status when a saved disable has not stopped the live server", async () => {
    const { menu, text } = create([{ ...userServer, enabled: false }]);
    await settle();
    expect(text()).toContain("saved; restart required");
    menu.dispose();
  });

  it("requires a confirmation before removing a user server", async () => {
    const { menu, controller, text } = create([userServer]);
    await settle();
    menu.handleInput("\r");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    expect(text()).toContain("Remove local-tools?");
    menu.handleInput("\r");
    expect(controller.remove).not.toHaveBeenCalled();
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    await settle();
    expect(controller.remove).toHaveBeenCalledExactlyOnceWith("local-tools");
    menu.dispose();
  });

  it("runs refresh only when explicitly selected", async () => {
    const { menu, controller, onChanged } = create();
    await settle();
    menu.handleInput("refresh");
    menu.handleInput("\r");
    await settle();
    expect(controller.refresh).toHaveBeenCalledOnce();
    expect(controller.list).toHaveBeenCalledTimes(2);
    expect(onChanged).not.toHaveBeenCalled();
    menu.dispose();
  });

  it("cancels slow discovery and ignores the late result", async () => {
    let resolveList!: (value: readonly McpServerSummary[]) => void;
    const { menu, controller, onCancel, requestRender } = create([], {
      list: () => new Promise((resolve) => { resolveList = resolve; }),
    });
    menu.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
    const renders = requestRender.mock.calls.length;
    resolveList([userServer]);
    await settle();
    expect(requestRender).toHaveBeenCalledTimes(renders);
    expect(controller.add).not.toHaveBeenCalled();
  });

  it("does not report a late save as a live connection after disposal", async () => {
    let resolveSave!: () => void;
    const { menu, onChanged, requestRender, controller } = create([], {
      add: () => new Promise<void>((resolve) => { resolveSave = resolve; }),
    });
    await settle();
    stdio(menu);
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    menu.dispose();
    const renders = requestRender.mock.calls.length;
    resolveSave();
    await settle();
    expect(onChanged).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledTimes(renders);
    expect(controller.list).toHaveBeenCalledOnce();
  });

  it("does not reveal backend error details that might contain server credentials", async () => {
    const { menu, text } = create([], { add: async () => { throw new Error("private-server-token"); } });
    await settle();
    http(menu);
    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    await settle();
    expect(text()).toContain("MCP operation failed");
    expect(text()).not.toContain("private-server-token");
    menu.dispose();
  });

  it.each([24, 40, 78, 100].flatMap((width) => [12, 24].map((rows) => ({ width, rows }))))(
    "keeps forms and menus on the same surface within $width columns and $rows rows",
    async ({ width, rows }) => {
      const { menu } = create([], {}, rows);
      await settle();
      const check = (input: boolean): void => {
        const frame = menu.render(width);
        expect(frame.length).toBeLessThanOrEqual(rows - 2);
        expect(frame[0]).toBe(renderAuthPanel([], width)[0]);
        for (const line of frame) expect(visibleWidth(line)).toBe(width);
        if (input) expect(frame.join("\n")).toContain(CURSOR_MARKER);
      };
      check(true);
      menu.handleInput("add");
      menu.handleInput("\r");
      check(true);
      field(menu, "demo");
      check(false);
      menu.dispose();
    },
  );
});
