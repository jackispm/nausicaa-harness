import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpManagement } from "../../src/cli/mcp-management.js";
import { readUserSettings, saveUserModel } from "../../src/config/user-settings.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-mcp-menu-"));
  roots.push(root);
  const settings = { filePath: join(root, "private", "settings.json") };
  const refresh = vi.fn(async () => {});
  const manager = createMcpManagement({
    settings, refresh,
    configuredSources: [{ sourceId: "project-source", type: "mcp", command: "never-execute" }],
    status: () => ({ enabled: true, refreshRequested: false, generation: 0, sources: [] }),
  });
  return { settings, refresh, manager };
}

describe("MCP management", () => {
  it("saves explicit grants privately without connecting and preserves concurrent model settings", async () => {
    const { settings, refresh, manager } = await fixture();
    await Promise.all([
      manager.add({ name: "docs", transport: "http", endpoint: "https://example.invalid/mcp", access: "read" }),
      saveUserModel("openai:test-model", settings),
    ]);
    const saved = await readUserSettings(settings);
    expect(saved.model).toBe("openai:test-model");
    expect(saved.edges?.grants).toEqual([{ sourceId: "docs", effects: ["read", "compute"], scopes: ["workspace", "run", "lane", "host"], allowWithoutApproval: true }]);
    expect(refresh).not.toHaveBeenCalled();
    expect((await stat(settings.filePath)).mode & 0o777).toBe(0o600);
    expect(await manager.list()).toContainEqual(expect.objectContaining({ name: "docs", status: "saved; restart required", toolCount: 0 }));
    expect(JSON.stringify(await manager.list())).not.toContain("example.invalid");
  });

  it("persists stdio argument arrays literally and removes only the selected source and grant", async () => {
    const { settings, manager } = await fixture();
    await manager.add({ name: "local", transport: "stdio", command: "never-execute", args: ["--flag", "space in arg", "$(not-a-shell)"], access: "full" });
    await manager.add({ name: "other", transport: "http", endpoint: "https://example.invalid/mcp", access: "read" });
    expect((await readUserSettings(settings)).edges?.sources?.[0]?.args).toEqual(["--flag", "space in arg", "$(not-a-shell)"]);
    await manager.setEnabled("local", false);
    expect((await readUserSettings(settings)).edges?.sources?.[0]?.enabled).toBe(false);
    await manager.remove("local");
    expect((await readUserSettings(settings)).edges?.sources?.map((source) => source.sourceId)).toEqual(["other"]);
    expect((await readUserSettings(settings)).edges?.grants?.map((source) => source.sourceId)).toEqual(["other"]);
  });

  it("rejects duplicate registrations even when writes race", async () => {
    const { manager } = await fixture();
    const input = { name: "docs", transport: "http" as const, endpoint: "https://example.invalid/mcp", access: "read" as const };
    const outcomes = await Promise.allSettled([manager.add(input), manager.add(input)]);
    expect(outcomes.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it.each([
    { name: "../unsafe", transport: "http", endpoint: "https://example.invalid/mcp", access: "read" },
    { name: "docs", transport: "http", endpoint: "file:///tmp/mcp", access: "read" },
    { name: "docs", transport: "http", endpoint: "https://user:secret@example.invalid/mcp", access: "read" },
    { name: "docs", transport: "stdio", command: "", access: "full" },
  ] as const)("rejects invalid MCP configuration before saving: $name $transport", async (input) => {
    const { manager, settings } = await fixture();
    await expect(manager.add(input)).rejects.toThrow();
    expect(await readUserSettings(settings)).toEqual({});
  });

  it("keeps externally managed sources read-only and refresh explicit", async () => {
    const { manager, refresh } = await fixture();
    expect(await manager.list()).toContainEqual(expect.objectContaining({ name: "project-source", origin: "project" }));
    await expect(manager.remove("project-source")).rejects.toThrow("not managed");
    await expect(manager.setEnabled("project-source", false)).rejects.toThrow("not managed");
    expect(refresh).not.toHaveBeenCalled();
    await manager.refresh();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
