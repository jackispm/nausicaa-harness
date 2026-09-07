import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCredentialStore } from "../../src/auth/index.js";
import { BracketedPasteDecoder, runAuthCommand, runUtilityCommand, type AuthModelPort, type Output, type SecretInput } from "../../src/cli/auth.js";
import { createBuiltinModelPort, createOpenRouterModelPort } from "../../src/model/index.js";

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
  it("decodes bracketed paste markers split across terminal chunks", () => {
    const decoder = new BracketedPasteDecoder();
    const values: string[] = [];
    decoder.push("\x1b[20", (value) => values.push(value));
    decoder.push("0~pasted", (value) => values.push(value));
    decoder.push(" value\x1b[20", (value) => values.push(value));
    decoder.push("1~", (value) => values.push(value));
    expect(values.join("")).toBe("pasted value");
  });

  it("saves through a hidden prompt without printing the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-cli-"));
    try {
      const input = new FakeSecretInput();
      const output = new MemoryOutput();
      const secretLengths: number[] = [];
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort = createOpenRouterModelPort({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
      const pending = runAuthCommand(
        { action: "login", provider: "openrouter", json: false },
        {
          credentialStore: store,
          modelPort,
          input,
          output,
          onAuthSecretInput: (length) => secretLengths.push(length),
        },
      );
      input.emitSecret("or-secret-1234\r");
      await expect(pending).resolves.toBe(0);
      expect(output.value).not.toContain("or-secret-1234");
      expect(secretLengths.at(-1)).toBe("or-secret-1234".length);
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

  it("normalizes provider ids for direct auth command callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-provider-case-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      await expect(runUtilityCommand(
        { action: "status", provider: "OPENAI", json: true },
        {
          userHome: root,
          output,
          environment: { OPENAI_API_KEY: "case-key" },
        },
      )).resolves.toBe(0);
      expect(JSON.parse(output.value)).toMatchObject({ provider: "openai", source: "environment" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses an injected environment for provider auth checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-env-context-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      await expect(runUtilityCommand(
        { action: "status", provider: "openai", json: true },
        {
          userHome: root,
          credentialStore: store,
          output,
          environment: { OPENAI_API_KEY: "injected-openai-key" },
        },
      )).resolves.toBe(0);
      expect(JSON.parse(output.value)).toMatchObject({
        provider: "openai",
        configured: true,
        source: "environment",
        environmentCredential: true,
      });
      expect(output.value).not.toContain("injected-openai-key");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps auth status usable when a provider-local check is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-status-unavailable-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      await store.modify("demo", async () => ({ type: "api_key", key: "stored-demo-key" }));
      const modelPort: AuthModelPort = {
        hasProvider: (provider) => provider === "demo",
        providerAuthTypes: () => ["api_key"],
        checkAuth: async () => { throw new Error("credential helper unavailable"); },
        login: async () => ({ type: "api_key", key: "unused" }),
        logout: async () => {},
      };
      await expect(runAuthCommand(
        { action: "status", provider: "demo", json: true },
        { credentialStore: store, modelPort, output, environment: {} },
      )).resolves.toBe(0);
      expect(JSON.parse(output.value)).toMatchObject({
        provider: "demo",
        configured: true,
        authCheck: "unavailable",
        authCheckFailed: true,
        source: "saved",
      });
      expect(output.value).not.toContain("stored-demo-key");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not mislabel a provider-owned saved auth check as environment auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-status-source-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort: AuthModelPort = {
        hasProvider: (provider) => provider === "demo",
        providerAuthTypes: () => ["api_key"],
        checkAuth: async () => ({ type: "api_key", source: "stored credential" }),
        login: async () => ({ type: "api_key", key: "unused" }),
        logout: async () => {},
      };
      await expect(runAuthCommand(
        { action: "status", provider: "demo", json: true },
        { credentialStore: store, modelPort, output, environment: {} },
      )).resolves.toBe(0);
      expect(JSON.parse(output.value)).toMatchObject({
        provider: "demo",
        configured: true,
        source: "saved",
        environmentCredential: false,
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("echoes non-secret auth fields while keeping API keys hidden", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-visible-fields-"));
    try {
      const input = new FakeSecretInput();
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort: AuthModelPort = {
        hasProvider: (provider) => provider === "demo",
        providerAuthTypes: () => ["api_key"],
        checkAuth: async () => undefined,
        logout: async () => {},
        login: async (_type, interaction) => {
          const key = await interaction.prompt({ type: "secret", message: "Enter API key" });
          const account = await interaction.prompt({ type: "text", message: "Enter account id" });
          expect(key).toBe("hidden-key");
          expect(account).toBe("account-123");
          return { type: "api_key", key };
        },
      };
      const pending = runAuthCommand(
        { action: "login", provider: "demo", json: false },
        { credentialStore: store, modelPort, input, output },
      );
      setTimeout(() => input.emitSecret("hidden-key\r"), 0);
      setTimeout(() => input.emitSecret("account-123\r"), 10);
      await expect(pending).resolves.toBe(0);
      expect(output.value).not.toContain("hidden-key");
      expect(output.value).toContain("account-123");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not offer the non-persisting Bedrock credential-chain login", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-bedrock-chain-"));
    try {
      const input = new FakeSecretInput();
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const modelPort = createBuiltinModelPort({
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      const pending = runAuthCommand(
        { action: "login", provider: "amazon-bedrock", json: false },
        { credentialStore: store, modelPort, input, output },
      );
      // The provider exposes three choices, but the host removes the choice
      // that would save an empty credential and never make auth resolvable.
      setTimeout(() => input.emitSecret("3\r"), 0);
      await expect(pending).rejects.toThrow("Invalid authentication selection");
      await expect(store.read("amazon-bedrock")).resolves.toBeUndefined();
      expect(output.value).toContain("credential chains are detected automatically");
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
        { action: "login", provider: "openai-codex", authType: "oauth", json: false },
        { credentialStore: store, modelPort: oauthOnly, input, output },
      )).resolves.toBe(0);
      expect(loginType).toBe("oauth");
      expect(output.value).toContain("Saved openai-codex oauth credential");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("forwards provider-owned OAuth events and prompt metadata without secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-auth-events-"));
    try {
      const output = new MemoryOutput();
      const store = new FileCredentialStore({ filePath: join(root, "credentials.json") });
      const events: string[] = [];
      const prompts: string[] = [];
      const oauthModel: AuthModelPort = {
        checkAuth: async () => undefined,
        logout: async () => {},
        hasProvider: (provider) => provider === "demo-oauth",
        providerAuthTypes: () => ["oauth"],
        login: async (_type, interaction) => {
          interaction.notify({ type: "auth_url", url: "https://example.test/device", instructions: "Open" });
          const code = await interaction.prompt({ type: "manual_code", message: "Enter the device code" });
          expect(code).toBe("device-code");
          return { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
        },
      };
      const input = new FakeSecretInput();
      const pending = runAuthCommand(
        { action: "login", provider: "demo-oauth", authType: "oauth", json: false },
        {
          credentialStore: store,
          modelPort: oauthModel,
          input,
          output,
          onAuthEvent: (event) => events.push(event.type),
          onAuthPrompt: (prompt) => prompts.push(prompt.type),
        },
      );
      input.emitSecret("device-code\r");
      await expect(pending).resolves.toBe(0);
      expect(events).toEqual(["auth_url"]);
      expect(prompts).toEqual(["manual_code"]);
      expect(output.value).toContain("https://example.test/device");
      expect(output.value).not.toContain("device-code");
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
