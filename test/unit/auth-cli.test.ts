import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCredentialStore } from "../../src/auth/index.js";
import { runAuthCommand, runUtilityCommand, type AuthModelPort, type Output, type SecretInput } from "../../src/cli/auth.js";
import { createOpenRouterModelPort } from "../../src/model/index.js";

class MemoryOutput implements Output {
  value = "";
  write(chunk: string): boolean { this.value += chunk; return true; }
}

class FakeSecretInput extends EventEmitter implements SecretInput {
  isTTY = true;
  modes: boolean[] = [];
  setRawMode(mode: boolean): SecretInput { this.modes.push(mode); return this; }
  resume(): void {}
  pause(): void {}
  emitSecret(value: string): void { this.emit("data", Buffer.from(value)); }
}

describe("auth/config CLI", () => {
  it("saves through a hidden prompt without printing the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-cli-"));
    try {
      const input = new FakeSecretInput();
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort = createOpenRouterModelPort({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
      const pending = runAuthCommand({ action: "login", provider: "openrouter", json: false }, { credentialStore: store, modelPort, input, output });
      input.emitSecret("or-secret-1234\r");
      await expect(pending).resolves.toBe(0);
      expect(output.value).not.toContain("or-secret-1234");
      await expect(readFile(join(root, "credentials.json"), "utf8")).resolves.toContain("or-secret-1234");
      expect(input.modes).toEqual([true, false]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("cancels a hidden prompt with Escape without saving a credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-cancel-"));
    try {
      const input = new FakeSecretInput();
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort = createOpenRouterModelPort({
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      const pending = runAuthCommand(
        { action: "login", provider: "openrouter", json: false },
        { credentialStore: store, modelPort, input, output },
      );
      input.emitSecret("\x1b");
      await expect(pending).rejects.toThrow("Login cancelled");
      await expect(store.read("openrouter")).resolves.toBeUndefined();
      expect(output.value).not.toContain("Login cancelled");
      expect(input.modes).toEqual([true, false]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reports local status and removes only saved credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-status-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      await store.modify("openrouter", async () => ({ type: "api_key", key: "or-secret-9876" }));
      const modelPort = createOpenRouterModelPort({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
      await expect(runAuthCommand({ action: "status", provider: "openrouter", json: true }, { credentialStore: store, modelPort, output, environment: { OPENROUTER_API_KEY: "ambient-key" } })).resolves.toBe(0);
      const status = JSON.parse(output.value) as Record<string, unknown>;
      expect(status).toMatchObject({ provider: "openrouter", configured: true, auth: "unverified", source: "saved", environmentCredential: true });
      expect(output.value).not.toContain("or-secret-9876");
      output.value = "";
      await expect(runAuthCommand({ action: "logout", provider: "openrouter", json: false }, { credentialStore: store, modelPort, output, environment: { OPENROUTER_API_KEY: "ambient-key" } })).resolves.toBe(0);
      expect(output.value).toContain("Environment credentials remain available");
      await expect(store.read("openrouter")).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not claim an environment credential remains when none is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-logout-no-env-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      await store.modify("openrouter", async () => ({ type: "api_key", key: "or-secret-no-env" }));
      const modelPort = createOpenRouterModelPort({
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      await expect(runAuthCommand(
        { action: "logout", provider: "openrouter", json: false },
        { credentialStore: store, modelPort, output, environment: {} },
      )).resolves.toBe(0);
      expect(output.value).toContain("No environment credential is configured");
      expect(output.value).not.toContain("remain available");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the built-in provider registry for non-OpenRouter status", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-provider-status-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort = createOpenRouterModelPort({
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      // An OpenRouter-only injected port still rejects provider-scoped auth;
      // the utility default is covered by the separate no-dependency path.
      await expect(runAuthCommand(
        { action: "status", provider: "openrouter", json: true },
        { credentialStore: store, modelPort, output, environment: {} },
      )).resolves.toBe(0);
      output.value = "";
      await expect(runUtilityCommand(
        { action: "status", provider: "anthropic", json: true },
        {
          userHome: root,
          output,
          environment: { ANTHROPIC_API_KEY: "ambient-anthropic" },
          authContext: {
            env: async (name) => name === "ANTHROPIC_API_KEY" ? "ambient-anthropic" : undefined,
            fileExists: async () => false,
          },
        },
      )).resolves.toBe(0);
      expect(JSON.parse(output.value)).toMatchObject({
        provider: "anthropic",
        configured: true,
        source: "environment",
        environmentCredential: true,
        auth: "unverified",
      });
      expect(output.value).not.toContain("ambient-anthropic");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("selects the OAuth flow for OAuth-only providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-oauth-only-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort = createOpenRouterModelPort({ credentials: store });
      let loginType: string | undefined;
      const oauthOnly: AuthModelPort = {
        checkAuth: modelPort.checkAuth.bind(modelPort),
        login: async (type) => {
          loginType = type;
          return { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
        },
        logout: modelPort.logout.bind(modelPort),
        hasProvider: (provider: string) => provider === "openai-codex",
        providerAuthTypes: () => ["oauth" as const],
      };
      const input = new FakeSecretInput();
      await expect(runAuthCommand(
        { action: "login", provider: "openai-codex", json: false },
        { credentialStore: store, modelPort: oauthOnly, input, output },
      )).resolves.toBe(0);
      expect(loginType).toBe("oauth");
      expect(output.value).toContain("Saved openai-codex oauth credential");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("persists the global model only through config set-model", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-config-cli-"));
    try {
      const output = new MemoryOutput();
      await expect(runUtilityCommand({ action: "set-model", model: "openrouter:demo", json: true }, { userHome: root, output })).resolves.toBe(0);
      expect(JSON.parse(output.value)).toMatchObject({ model: "openrouter:demo" });
      output.value = "";
      await expect(runUtilityCommand({ action: "get-model", json: false }, { userHome: root, output })).resolves.toBe(0);
      expect(output.value.trim()).toBe("openrouter:demo");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes concurrent default-model updates without losing the settings document", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-config-race-"));
    try {
      const firstOutput = new MemoryOutput();
      const secondOutput = new MemoryOutput();
      await Promise.all([
        runUtilityCommand({ action: "set-model", model: "openrouter:first", json: false }, { userHome: root, output: firstOutput }),
        runUtilityCommand({ action: "set-model", model: "openrouter:second", json: false }, { userHome: root, output: secondOutput }),
      ]);
      const output = new MemoryOutput();
      await expect(runUtilityCommand({ action: "get-model", json: false }, { userHome: root, output })).resolves.toBe(0);
      expect(["openrouter:first", "openrouter:second"]).toContain(output.value.trim());
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
