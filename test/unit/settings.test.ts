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
    expect(
      resolveSettings(
        "/work",
        { model: "openrouter:base", maxSteps: 3 },
        { model: "openrouter:override", maxOutputTokens: 8_192 },
        {},
      ),
    ).toMatchObject({
      model: "openrouter:override",
      tetoModel: "openrouter:override",
      tetoEnabled: true,
      maxSteps: 3,
      maxOutputTokens: 8_192,
      dataDir: "/work/.nausicaa",
      allowShell: false,
      allowWrite: true,
      allowNetwork: false,
      fukaiCompaction: {
        enabled: false,
        provider: "none",
        maxInputTokens: 32_000,
        maxOutputTokens: 4_096,
        maxWallClockMs: 60_000,
        thresholdRatio: 0.8,
        retainRatio: 0.16,
        minimumGainTokens: 1,
      },
    });
  });

  it("keeps Fukai compaction disabled by default without selecting a provider", () => {
    const resolved = resolveSettings(
      "/work",
      { model: "openrouter:base" },
      {},
      {},
    );

    expect(resolved.fukaiCompaction).toEqual({
      enabled: false,
      provider: "none",
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
      maxWallClockMs: 60_000,
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      minimumGainTokens: 1,
    });
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

  it("keeps shell access disabled by default and independent from writes", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", allowWrite: true },
      {},
      {},
    )).toMatchObject({ allowShell: false, allowWrite: true });
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base", allowWrite: true },
      { allowShell: true, allowWrite: false },
      {},
    )).toMatchObject({ allowShell: true, allowWrite: false });
  });

  it("keeps network access disabled by default and supports explicit overrides", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      {},
      {},
    ).allowNetwork).toBe(false);
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      { allowNetwork: true },
      {},
    ).allowNetwork).toBe(true);
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
