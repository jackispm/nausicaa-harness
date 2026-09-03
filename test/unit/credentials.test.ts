import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialStoreError, FileCredentialStore } from "../../src/auth/index.js";

const roots: string[] = [];

describe("file credential store", () => {
  it("persists private metadata and credential data", async () => {
    const root = await makeRoot();
    const path = join(root, "nested", "credentials.json");
    const store = new FileCredentialStore({ filePath: path });
    await expect(store.read("openrouter")).resolves.toBeUndefined();
    await store.modify("openrouter", async () => ({ type: "api_key", key: "or-secret-1234" }));
    await expect(store.read("openrouter")).resolves.toEqual({ type: "api_key", key: "or-secret-1234" });
    await expect(store.list()).resolves.toEqual([{ providerId: "openrouter", type: "api_key" }]);
    await expect(readFile(path, "utf8")).resolves.toContain("or-secret-1234");
    await expect(stat(join(root, "nested"))).resolves.toMatchObject({ mode: 0o40700 });
    await expect(stat(path)).resolves.toMatchObject({ mode: 0o100600 });
  });

  it("serializes concurrent updates and keeps undefined modify as a no-op", async () => {
    const root = await makeRoot();
    const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
    await Promise.all([
      store.modify("openrouter", async () => ({ type: "api_key", key: "first" })),
      store.modify("openrouter", async (current) => ({
        type: "api_key",
        key: current?.type === "api_key" ? `${current.key}-second` : "second",
      })),
    ]);
    await expect(store.read("openrouter")).resolves.toMatchObject({ key: "first-second" });
    await store.modify("openrouter", async () => undefined);
    await expect(store.read("openrouter")).resolves.toMatchObject({ key: "first-second" });
    await store.delete("openrouter");
    await expect(store.read("openrouter")).resolves.toBeUndefined();
  });

  it("fails closed on malformed data and path-like provider ids", async () => {
    const root = await makeRoot();
    const path = join(root, "credentials.json");
    await mkdir(root, { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, credentials: { openrouter: { key: "secret" } } }));
    await expect(new FileCredentialStore({ filePath: path }).read("openrouter"))
      .rejects.toBeInstanceOf(CredentialStoreError);
    await expect(new FileCredentialStore({ filePath: path }).read("../escape"))
      .rejects.toThrow("provider id is invalid");
  });

  it("rejects symlinked credential files and parent directories", async () => {
    const root = await makeRoot();
    const targetDirectory = join(root, "target");
    await mkdir(targetDirectory, { recursive: true });
    const parentLink = join(root, "linked-parent");
    await symlink(targetDirectory, parentLink, "dir");
    const linkedParentStore = new FileCredentialStore({
      filePath: join(parentLink, "credentials.json"),
    });
    await expect(linkedParentStore.modify("openrouter", async () => ({
      type: "api_key",
      key: "secret",
    }))).rejects.toThrow(/private directory/i);

    const realPath = join(targetDirectory, "credentials.json");
    await writeFile(realPath, JSON.stringify({
      version: 1,
      credentials: { openrouter: { type: "api_key", key: "secret" } },
    }));
    const fileLink = join(root, "linked-credentials.json");
    await symlink(realPath, fileLink, "file");
    await expect(new FileCredentialStore({ filePath: fileLink }).read("openrouter"))
      .rejects.toThrow(/regular file/i);
  });

  it("cancels while waiting for a cross-process lock", async () => {
    const root = await makeRoot();
    const path = join(root, "credentials.json");
    await writeFile(`${path}.lock`, "held\n");
    const store = new FileCredentialStore({ filePath: path, lockTimeoutMs: 2_000 });
    const controller = new AbortController();
    const pending = store.modify(
      "openrouter",
      async () => ({ type: "api_key", key: "cancelled" }),
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-credentials-"));
  roots.push(root);
  return root;
}
