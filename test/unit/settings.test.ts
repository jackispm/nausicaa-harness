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
  it("layers project settings over user settings", async () => {
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

    await expect(loadSettings(workspace, home)).resolves.toEqual({
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

    await expect(loadSettings(workspace, join(root, "home"))).rejects.toBeInstanceOf(
      SettingsError,
    );
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
    });
  });
});
