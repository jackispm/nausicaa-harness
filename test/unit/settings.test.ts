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
        { model: "openrouter:override" },
        {},
      ),
    ).toMatchObject({
      model: "openrouter:override",
      tetoModel: "openrouter:override",
      tetoEnabled: true,
      maxSteps: 3,
      dataDir: "/work/.nausicaa",
      allowWrite: false,
    });
  });

  it("keeps writes disabled by default and supports explicit overrides", () => {
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      {},
      {},
    ).allowWrite).toBe(false);
    expect(resolveSettings(
      "/work",
      { model: "openrouter:base" },
      { allowWrite: true },
      {},
    ).allowWrite).toBe(true);
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
});
