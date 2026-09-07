import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadSettings,
  resolveSettings,
  SettingsError,
} from "../../src/config/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-settings-"));
  roots.push(root);
  return root;
};

describe("settings", () => {
  it("reads only user settings unless workspace settings are explicitly trusted", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await mkdir(join(workspace, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({ model: "openrouter:user-model", maxSteps: 10 }),
    );
    await writeFile(
      join(workspace, ".nausicaa", "settings.json"),
      JSON.stringify({ maxSteps: 6, tetoEnabled: false }),
    );

    await expect(loadSettings(workspace, { userHome: home })).resolves.toEqual({
      model: "openrouter:user-model",
      maxSteps: 10,
    });
    await expect(loadSettings(workspace, {
      userHome: home,
      trustWorkspace: true,
    })).resolves.toEqual({
      model: "openrouter:user-model",
      maxSteps: 6,
      tetoEnabled: false,
    });
  });

  it("deep-merges nested Fukai settings across trusted user and workspace files", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await mkdir(join(workspace, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({
        model: "openrouter:user-model",
        fukaiCompaction: { enabled: true, provider: "pi-ai", maxInputTokens: 12_000 },
      }),
    );
    await writeFile(
      join(workspace, ".nausicaa", "settings.json"),
      JSON.stringify({ fukaiCompaction: { maxOutputTokens: 2_048 } }),
    );

    await expect(loadSettings(workspace, {
      userHome: home,
      trustWorkspace: true,
    })).resolves.toMatchObject({
      fukaiCompaction: {
        enabled: true,
        provider: "pi-ai",
        maxInputTokens: 12_000,
        maxOutputTokens: 2_048,
      },
    });
  });

  it("keeps credentials out of the settings schema", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".nausicaa"), { recursive: true });
    await writeFile(
      join(workspace, ".nausicaa", "settings.json"),
      JSON.stringify({ apiKey: "must-not-be-here" }),
    );

    await expect(loadSettings(workspace, {
      userHome: join(root, "home"),
      trustWorkspace: true,
    })).rejects.toBeInstanceOf(SettingsError);
  });

  it("does not let an untrusted workspace redirect state or model spend", async () => {
    const root = await makeRoot();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".nausicaa"), { recursive: true });
    await writeFile(
      join(workspace, ".nausicaa", "settings.json"),
      JSON.stringify({
        dataDir: "../../outside",
        model: "openrouter:expensive-model",
        maxModelTokens: 9_000_000,
      }),
    );

    await expect(loadSettings(workspace, {
      userHome: join(root, "home"),
    })).resolves.toEqual({});
  });

  it("resolves defaults and explicit overrides", () => {
    const resolved = resolveSettings(
      "/work",
      { model: "openrouter:base", maxSteps: 3 },
      { model: "openrouter:override", maxOutputTokens: 8_192 },
      {},
    );
    expect(resolved).toMatchObject({
      model: "openrouter:override",
      tetoModel: "openrouter:override",
      tetoEnabled: true,
      maxSteps: 3,
      maxOutputTokens: 8_192,
      dataDir: "/work/.nausicaa",
      allowShell: true,
      allowWrite: true,
      allowNetwork: true,
      fukaiCompaction: {
        enabled: true,
        provider: "pi-ai",
        maxInputTokens: 32_000,
        maxOutputTokens: 4_096,
        maxWallClockMs: 60_000,
        thresholdRatio: 0.8,
        retainRatio: 0.16,
        minimumGainTokens: 1,
      },
    });
    expect(resolved.maxModelTokens).toBeUndefined();
  });

  it("keeps explicit and settings model choices ahead of the environment fallback", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:settings" },
      { model: "openrouter:explicit" },
      { NAUSICAA_MODEL: "openrouter:environment" },
    ).model).toBe("openrouter:explicit");
    expect(resolveSettings(
      "/work",
      { model: "openrouter:settings" },
      {},
      { NAUSICAA_MODEL: "openrouter:environment" },
    ).model).toBe("openrouter:settings");
    expect(resolveSettings(
      "/work",
      {},
      {},
      { NAUSICAA_MODEL: "openrouter:environment" },
    ).model).toBe("openrouter:environment");
  });

  it("enables Fukai compaction by default with the existing model provider", () => {
    const resolved = resolveSettings(
      "/work",
      { model: "openrouter:base" },
      {},
      {},
    );

    expect(resolved.fukaiCompaction).toEqual({
      enabled: true,
      provider: "pi-ai",
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
      maxWallClockMs: 60_000,
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      minimumGainTokens: 1,
    });
  });

  it("preserves explicit compaction opt-outs in settings and overrides", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", fukaiCompaction: { enabled: false } },
      {},
      {},
    ).fukaiCompaction).toMatchObject({ enabled: false, provider: "none" });
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", fukaiCompaction: { enabled: true, provider: "pi-ai" } },
      { fukaiCompaction: { enabled: false } },
      {},
    ).fukaiCompaction).toMatchObject({ enabled: false, provider: "pi-ai" });
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", fukaiCompaction: { provider: "none" } },
      {},
      {},
    ).fukaiCompaction).toMatchObject({ enabled: false, provider: "none" });
  });

  it("merges and bounds explicit Fukai compaction settings", () => {
    expect(resolveSettings(
      "/work",
      {
        model: "openrouter:base",
        fukaiCompaction: {
          enabled: true,
          provider: "pi-ai",
          maxInputTokens: 12_000,
          maxWallClockMs: 30_000,
        },
      },
      { fukaiCompaction: { maxOutputTokens: 2_048 } },
      {},
    ).fukaiCompaction).toEqual({
      enabled: true,
      provider: "pi-ai",
      maxInputTokens: 12_000,
      maxOutputTokens: 2_048,
      maxWallClockMs: 30_000,
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      minimumGainTokens: 1,
    });

    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", fukaiCompaction: { enabled: true } },
      {},
      {},
    ).fukaiCompaction.provider).toBe("pi-ai");

    expect(() => resolveSettings(
      "/work",
      {
        model: "openrouter:base",
        fukaiCompaction: { maxOutputTokens: 16 * 1024 * 1024 + 1 },
      },
      {},
      {},
    )).toThrow(/fukaiCompaction\.maxOutputTokens.*16.*777.*216/i);

    expect(() => resolveSettings(
      "/work",
      {
        model: "openrouter:base",
        fukaiCompaction: { enabled: true, provider: "none" },
      },
      {},
      {},
    )).toThrow(/enabled.*provider.*pi-ai/i);
  });

  it("defaults and bounds the per-call Main output limit", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      {},
      {},
    ).maxOutputTokens).toBe(4_096);
    expect(() => resolveSettings(
      "/work",
      { model: "openrouter:base", maxOutputTokens: 1_000_001 },
      {},
      {},
    )).toThrow(/maxOutputTokens.*1.*1000000/i);
  });

  it("keeps the aggregate Run token budget opt-in", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      { maxModelTokens: 12_345 },
      {},
    ).maxModelTokens).toBe(12_345);
    expect(() => resolveSettings(
      "/work",
      { model: "openrouter:base", maxModelTokens: 0 },
      {},
      {},
    )).toThrow(/maxModelTokens/);
  });

  it("enables workspace writes by default and supports explicit overrides", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      {},
      {},
    ).allowWrite).toBe(true);
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      { allowWrite: false },
      {},
    ).allowWrite).toBe(false);
  });

  it("starts with host shell access by default and keeps overrides independent", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", allowWrite: true },
      {},
      {},
    )).toMatchObject({ allowShell: true, allowWrite: true });
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", allowWrite: true },
      { allowShell: true, allowWrite: false },
      {},
    )).toMatchObject({ allowShell: true, allowWrite: false });
  });

  it("starts with network access by default and supports explicit overrides", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      {},
      {},
    ).allowNetwork).toBe(true);
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      { allowNetwork: true },
      {},
    ).allowNetwork).toBe(true);
  });

  it("enables configured sources and startup refresh without adding servers or grants", () => {
    const defaults = resolveSettings("/work", { model: "m" }, {}, {});
    expect(defaults.edges).toMatchObject({
      enabled: true,
      refreshOnStart: true,
      sources: [],
      grants: [],
    });
    const disabled = resolveSettings("/work", {
      model: "m",
      edges: { enabled: false, refreshOnStart: false },
    }, {}, {});
    expect(disabled.edges).toMatchObject({ enabled: false, refreshOnStart: false });
    expect(resolveSettings("/work", { model: "m" }, {
      edges: { enabled: false, refreshOnStart: false },
    }, {}).edges).toMatchObject({ enabled: false, refreshOnStart: false });
  });

  it("loads and resolves configured edge declarations without starting adapters", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({
        model: "openrouter:base",
        edges: {
          enabled: true,
          refreshOnStart: true,
          sources: [
            { sourceId: "local-skills", type: "skill", location: "skills" },
            { sourceId: "review-server", type: "mcp", command: "fake-mcp", args: ["--stdio"] },
          ],
        },
      }),
    );

    const loaded = await loadSettings(workspace, { userHome: home });
    expect(loaded.edges?.sources).toHaveLength(2);
    const resolved = resolveSettings(workspace, loaded, {}, {});
    expect(resolved.edges).toMatchObject({
      enabled: true,
      refreshOnStart: true,
      sources: [
        { sourceId: "local-skills", type: "skill", location: "skills" },
        { sourceId: "review-server", type: "mcp", command: "fake-mcp", args: ["--stdio"] },
      ],
    });
    expect(Object.isFrozen(resolved.edges.sources)).toBe(true);
    expect(Object.isFrozen(resolved.edges.sources[1]?.args)).toBe(true);
  });

  it("loads explicit Streamable HTTP MCP sources with bounded host headers", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({
        model: "openrouter:base",
        edges: {
          enabled: true,
          sources: [{
            sourceId: "remote-mcp",
            type: "mcp",
            endpoint: "https://mcp.example.test/v1",
            headers: { Authorization: "Bearer host-secret" },
            sessionId: "session-1",
          }],
        },
      }),
    );

    const loaded = await loadSettings(root, { userHome: home });
    const resolved = resolveSettings(root, loaded, {}, {});
    expect(resolved.edges.sources).toEqual([expect.objectContaining({
      sourceId: "remote-mcp",
      type: "mcp",
      endpoint: "https://mcp.example.test/v1",
      headers: { Authorization: "Bearer host-secret" },
      sessionId: "session-1",
    })]);
    expect(Object.isFrozen(resolved.edges.sources[0]?.headers)).toBe(true);
  });

  it("loads host grants separately and bounds their authority", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(join(home, ".nausicaa", "settings.json"), JSON.stringify({
      model: "openrouter:base",
      edges: {
        enabled: true,
        sources: [{ sourceId: "docs", type: "mcp", command: "fake-mcp", args: ["--stdio"] }],
        grants: [{ sourceId: "docs", effects: ["read"], scopes: ["workspace"], allowWithoutApproval: true }],
      },
    }));
    const loaded = await loadSettings(join(root, "workspace"), { userHome: home });
    const resolved = resolveSettings(join(root, "workspace"), loaded, {}, {});
    expect(resolved.edges.grants).toEqual([{
      sourceId: "docs",
      effects: ["read"],
      scopes: ["workspace"],
      allowWithoutApproval: true,
    }]);
    expect(Object.isFrozen(resolved.edges.grants)).toBe(true);
    expect(Object.isFrozen(resolved.edges.grants[0]?.effects)).toBe(true);
  });

  it("rejects unsafe source paths, stdio mismatches, and oversized declarations", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    const settingsPath = join(home, ".nausicaa", "settings.json");
    const write = async (value: unknown) => writeFile(settingsPath, JSON.stringify({ model: "m", edges: value }));

    await write({ sources: [{ sourceId: "mcp", type: "mcp", command: "fake", location: "bad" }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/location is not allowed/i);
    await write({ sources: [{ sourceId: "skill", type: "skill", location: "skills", command: "fake" }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/command\/args are only allowed/i);
    await write({ sources: [{ sourceId: "bad\nsource", type: "skill", location: "skills" }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/control characters/i);
    await write({ sources: [{ sourceId: "bad source", type: "skill", location: "skills" }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/must not contain whitespace/i);
    await write({ sources: [{ sourceId: "mcp", type: "mcp", endpoint: "https://user:pass@example.test/mcp" }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/embedded credentials/i);
    await write({ sources: [{ sourceId: "mcp", type: "mcp", endpoint: "https://example.test/mcp", headers: { "bad name": "value" } }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/invalid header name/i);
    await write({ sources: [{ sourceId: "mcp", type: "mcp", command: "fake", headers: { Authorization: "secret" } }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/require an MCP endpoint/i);
    await write({ grants: [{ sourceId: "grant", effects: ["write", "write"], scopes: ["workspace"] }] });
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/must not contain duplicates/i);
  });

  it("ignores project edge sources and grants when workspace trust is absent", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await mkdir(join(workspace, ".nausicaa"), { recursive: true });
    await writeFile(join(home, ".nausicaa", "settings.json"), JSON.stringify({
      model: "m",
      edges: { grants: [{ sourceId: "user", effects: ["read"], scopes: ["run"] }] },
    }));
    await writeFile(join(workspace, ".nausicaa", "settings.json"), JSON.stringify({
      edges: {
        enabled: true,
        sources: [{ sourceId: "project", type: "mcp", command: "fake" }],
        grants: [{ sourceId: "project", effects: ["write"], scopes: ["host"] }],
      },
    }));
    await expect(loadSettings(workspace, { userHome: home })).resolves.toMatchObject({
      model: "m",
      edges: { grants: [{ sourceId: "user" }] },
    });
  });

  it("deep-merges trusted edge settings while preserving user source declarations", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await mkdir(join(workspace, ".nausicaa"), { recursive: true });
    await writeFile(join(home, ".nausicaa", "settings.json"), JSON.stringify({
      model: "openrouter:base",
      edges: {
        enabled: true,
        sources: [{ sourceId: "user-skill", type: "skill", location: "skills" }],
      },
    }));
    await writeFile(join(workspace, ".nausicaa", "settings.json"), JSON.stringify({
      edges: { refreshOnStart: true },
    }));

    await expect(loadSettings(workspace, {
      userHome: home,
      trustWorkspace: true,
    })).resolves.toMatchObject({
      edges: {
        enabled: true,
        refreshOnStart: true,
        sources: [{ sourceId: "user-skill" }],
      },
    });
  });

  it("rejects duplicate edge identities and incomplete source declarations", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    const settingsPath = join(home, ".nausicaa", "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      model: "openrouter:base",
      edges: {
        sources: [
          { sourceId: "same", type: "skill", location: "skills" },
          { sourceId: "same", type: "plugin", location: "plugin" },
        ],
      },
    }));
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/duplicate edge sourceId/i);

    await writeFile(settingsPath, JSON.stringify({
      model: "openrouter:base",
      edges: { sources: [{ sourceId: "broken", type: "mcp" }] },
    }));
    await expect(loadSettings(root, { userHome: home })).rejects.toThrow(/command is required/i);
  });

  it("validates allowNetwork in settings files", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({ model: "openrouter:base", allowNetwork: "yes" }),
    );

    await expect(loadSettings(join(root, "workspace"), { userHome: home }))
      .rejects.toThrow(/allowNetwork.*boolean/i);
  });

  it("validates allowWrite in settings files", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({ model: "openrouter:base", allowWrite: "yes" }),
    );

    await expect(loadSettings(join(root, "workspace"), { userHome: home }))
      .rejects.toThrow(/allowWrite.*boolean/i);
  });

  it("validates allowShell in settings files", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({ model: "openrouter:base", allowShell: "yes" }),
    );

    await expect(loadSettings(join(root, "workspace"), { userHome: home }))
      .rejects.toThrow(/allowShell.*boolean/i);
  });

  it("validates the nested Fukai compaction settings", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({
        model: "openrouter:base",
        fukaiCompaction: { provider: "unknown" },
      }),
    );

    await expect(loadSettings(join(root, "workspace"), { userHome: home }))
      .rejects.toThrow(/fukaiCompaction\.provider.*none or pi-ai/i);
  });

  it("allows a selected provider to remain disabled", async () => {
    const root = await makeRoot();
    const home = join(root, "home");
    await mkdir(join(home, ".nausicaa"), { recursive: true });
    await writeFile(
      join(home, ".nausicaa", "settings.json"),
      JSON.stringify({
        model: "openrouter:base",
        fukaiCompaction: { enabled: false, provider: "pi-ai" },
      }),
    );

    await expect(loadSettings(join(root, "workspace"), { userHome: home }))
      .resolves.toMatchObject({
        fukaiCompaction: { enabled: false, provider: "pi-ai" },
      });
  });
});
