import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { createCrossRunMessageId, createCrossRunRouteId } from "../../src/a2a/index.js";
import { FileCredentialStore } from "../../src/auth/index.js";
import type { AuthModelPort } from "../../src/cli/auth.js";
import { createBuiltinModelPort, createOpenRouterModelPort } from "../../src/model/index.js";
import {
  clipboardImagePasteKey,
  runInteractive,
  type InteractiveAuthOptions,
  type InteractiveOptions,
} from "../../src/cli/interactive.js";
import {
  inspectCredential,
  startupGuidance,
  UNCONFIGURED_MODEL,
} from "../../src/cli/onboarding.js";
import {
  getNausicaaColorScheme,
  setNausicaaColorScheme,
} from "../../src/cli/tui-components.js";
import type {
  AgentTool,
  A2AMessage,
  AnyEvent,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../../src/domain/index.js";
import { JsonlLedger } from "../../src/ledger/index.js";
import { ScriptedModel, type ModelCatalogEntry } from "../../src/model/index.js";
import {
  listWorkspaceRuns,
  SessionController,
  type SessionRuntimeEvent,
} from "../../src/runtime/index.js";
import { MESSAGE_MEDIA_TYPE } from "../../src/runtime/session-artifacts.js";
import { FileContentAddressedStore } from "../../src/store/index.js";
import { WorkspaceCommandSandbox } from "../../src/tools/index.js";
import type { ShellExecutionResult } from "../../src/tools/shell-process.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

describe("interactive TUI", () => {
  it("rejects the removed providers command without invoking a model", async () => {
    await withAuthTui({}, async ({ terminal, mainModel }) => {
      terminal.type("/providers");
      terminal.send("\r");
      await waitForOutput(terminal, "Unknown command: /providers");
      expect(mainModel.callCount).toBe(0);
      expect(terminal.output).not.toContain("Search providers");
    });
  });

  it("defaults to configured providers and counts only the visible models", async () => {
    await withAuthTui({}, async ({ terminal, credentialStore }) => {
      await credentialStore.modify("openai", async () => ({ type: "api_key", key: "test-openai" }));
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      expect(terminal.output).toContain("1 model");
      expect(terminal.output).toContain("Configured locally");
      expect(terminal.output).not.toContain("Other model mentioning openai");
      terminal.send("\x1b[C");
      await waitForOutput(terminal, "2 models");
      await waitForOutput(terminal, "Login required");
      const beforeFilter = terminal.output.length;
      terminal.send("\t");
      terminal.send("\x1b[C");
      await waitForCondition(async () => terminal.output.slice(beforeFilter).includes("1 model"), "provider-filtered count");
      expect(terminal.output.slice(beforeFilter)).toContain("Other model mentioning openai");
      const beforeSearch = terminal.output.length;
      terminal.type("no-such-model-xyz");
      await waitForCondition(async () => terminal.output.slice(beforeSearch).includes("0 models"), "search-filtered count");
    });
  });

  it("keeps models from every configured provider, including environment credentials", async () => {
    await withAuthTui({ environment: { OPENAI_API_KEY: "test-env-key" } }, async ({ terminal, credentialStore }) => {
      await credentialStore.modify("anthropic", async () => ({ type: "api_key", key: "test-anthropic" }));
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      expect(terminal.output).toContain("2 models");
      expect(terminal.output).toContain("OPENAI_API_KEY");
      expect(terminal.output).not.toContain("Login required");
      expect(terminal.output).not.toContain("test-env-key");
    });
  });

  it("scopes the installed catalog to OpenRouter when only OpenRouter is configured", async () => {
    let choices: readonly string[] = [];
    await withAuthTui({ modelChoices: () => choices }, async ({ terminal, credentialStore, modelPort }) => {
      const catalog = modelPort.catalog();
      choices = catalog.map((entry) => entry.selector);
      const openRouterCount = catalog.filter((entry) => entry.provider === "openrouter").length;
      expect(openRouterCount).toBeGreaterThan(0);
      expect(openRouterCount).toBeLessThan(catalog.length);
      await credentialStore.modify("openrouter", async () => ({ type: "api_key", key: "test-router-key" }));
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      expect(terminal.output).toContain(`${openRouterCount} models`);
      expect(terminal.output).not.toContain(`${catalog.length} models`);
      expect(terminal.output).not.toContain("Login required");
      expect(terminal.output).not.toContain("test-router-key");
      terminal.send("\x1b[C");
      await waitForOutput(terminal, `${catalog.length} models`);
    });
  });

  it("does not silently expose the full catalog when no credentials are configured", async () => {
    await withAuthTui({}, async ({ terminal, session }) => {
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      expect(terminal.output).toContain("0 models");
      expect(terminal.output).not.toContain("Other model mentioning openai");
      terminal.send("\r");
      expect(session.model).toBe(UNCONFIGURED_MODEL);
      terminal.send("\x1b[C");
      await waitForOutput(terminal, "2 models");
    });
  });

  it("treats model command arguments as search terms and preserves the model until selection", async () => {
    await withAuthTui({}, async ({ terminal, credentialStore, session }) => {
      await credentialStore.modify("openai", async () => ({ type: "api_key", key: "test-openai" }));
      terminal.type("/model openai model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      expect(terminal.output).toContain("1 model");
      expect(terminal.output).not.toContain("without spaces");
      expect(session.model).toBe(UNCONFIGURED_MODEL);
      terminal.send("\r");
      await waitForCondition(async () => session.model === "openai:test-model", "searched model selected");
    });
  });

  it("authenticates an unconfigured model from the full catalog before switching", async () => {
    await withAuthTui({}, async ({ terminal, session, credentialStore, mainModel }) => {
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      terminal.send("\x1b[C");
      terminal.type("OpenAI model");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      expect(session.model).toBe(UNCONFIGURED_MODEL);
      terminal.send("test-handoff-secret\r");
      await waitForCondition(async () => session.model === "openai:test-model", "model selected after login");
      await expect(credentialStore.read("openai")).resolves.toMatchObject({ type: "api_key" });
      expect(terminal.output).not.toContain("test-handoff-secret");
      expect(mainModel.callCount).toBe(0);
    });
  });

  it("keeps the current model if login for an exact model selection is cancelled", async () => {
    await withAuthTui({ model: "anthropic:current-model" }, async ({ terminal, session, credentialStore }) => {
      terminal.type("/model openai:test-model");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      terminal.send("\x1b");
      await waitForOutput(terminal, "Login cancelled.");
      expect(session.model).toBe("anthropic:current-model");
      await expect(credentialStore.list()).resolves.toEqual([]);
    });
  });

  it("keeps auth-check failures out of the configured scope", async () => {
    await withAuthTui({ checkAuth: async () => { throw new Error("test auth failure"); } }, async ({ terminal, session }) => {
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      expect(terminal.output).toContain("0 models");
      terminal.send("\x1b[C");
      await waitForOutput(terminal, "Auth status unavailable");
      terminal.type("OpenAI model");
      terminal.send("\r");
      await waitForOutput(terminal, "Model was not changed");
      expect(session.model).toBe(UNCONFIGURED_MODEL);
    });
  });

  it("does not reopen a dismissed model picker when auth discovery finishes late", async () => {
    let complete!: (value: undefined) => void;
    const pending = new Promise<undefined>((resolve) => { complete = resolve; });
    await withAuthTui({ checkAuth: () => pending }, async ({ terminal }) => {
      try {
        terminal.type("/model");
        terminal.send("\r");
        await waitForOutput(terminal, "Checking local credentials");
        terminal.send("\x1b");
        complete(undefined);
        terminal.type("/status");
        terminal.send("\r");
        await waitForOutput(terminal, "Model:");
        expect(terminal.output).not.toContain("Search models");
      } finally {
        complete(undefined);
      }
    });
  });

  it("shuts down without waiting for model authentication discovery", async () => {
    let complete!: (value: undefined) => void;
    const pending = new Promise<undefined>((resolve) => { complete = resolve; });
    await withAuthTui({ checkAuth: () => pending }, async ({ terminal, running }) => {
      try {
        terminal.type("/model");
        terminal.send("\r");
        await waitForOutput(terminal, "Checking local credentials");
        process.emit("SIGTERM", "SIGTERM");
        await expect(running).resolves.toBe(0);
        complete(undefined);
        expect(terminal.output).not.toContain("Search models");
      } finally {
        complete(undefined);
      }
    });
  });

  it("drops a logged-out provider from the next model picker even if its model is current", async () => {
    await withAuthTui({ model: "openai:test-model" }, async ({ terminal, credentialStore, session }) => {
      await credentialStore.modify("openai", async () => ({ type: "api_key", key: "test-key" }));
      terminal.type("/logout openai");
      terminal.send("\r");
      await waitForOutput(terminal, "Removed the saved openai credential");
      const before = terminal.output.length;
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Search models");
      expect(terminal.output.slice(before)).toContain("0 models");
      expect(session.model).toBe("openai:test-model");
    });
  });

  it("allows cancellation before removing the only saved credential", async () => {
    await withAuthTui({ environment: { OPENAI_API_KEY: "test-env-key" } }, async ({ terminal, credentialStore }) => {
      await credentialStore.modify("openai", async () => ({ type: "api_key", key: "test-saved-key" }));
      terminal.type("/logout");
      terminal.send("\r");
      await waitForOutput(terminal, "Search saved accounts");
      terminal.send("\x1b");
      await expect(credentialStore.read("openai")).resolves.toMatchObject({ type: "api_key" });
      const before = terminal.output.length;
      terminal.type("/logout");
      terminal.send("\r");
      await waitForCondition(async () => terminal.output.slice(before).includes("Search saved accounts"), "single credential picker reopened");
      terminal.send("\r");
      await waitForOutput(terminal, "Any environment credential remains available");
      await expect(credentialStore.read("openai")).resolves.toBeUndefined();
    });
  });

  it("opens the signed-in provider's model list after first login without selecting a model", async () => {
    await withAuthTui({}, async ({ terminal, session, credentialStore, mainModel }) => {
      terminal.type("/login");
      terminal.send("\r");
      await waitForOutput(terminal, "Search providers");
      terminal.type("openai");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      terminal.send("test-openai-secret\r");
      await waitForOutput(terminal, "Search models");
      expect(session.model).toBe(UNCONFIGURED_MODEL);
      expect(session.snapshot().runId).toBeUndefined();
      expect(mainModel.callCount).toBe(0);
      expect(terminal.output).not.toContain("test-openai-secret");
      await expect(credentialStore.read("openai")).resolves.toMatchObject({ type: "api_key" });
      terminal.send("\r");
      await waitForCondition(async () => session.model === "openai:test-model", "OpenAI model selection");
      expect(session.model).not.toBe("anthropic:openai-lookalike");
    });
  });

  it("keeps the current model after signing in to another provider", async () => {
    await withAuthTui({ model: "anthropic:current-model" }, async ({ terminal, session }) => {
      terminal.type("/login openai");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      terminal.send("test-openai-secret\r");
      await waitForOutput(terminal, "Signed in to openai");
      expect(session.model).toBe("anthropic:current-model");
      expect(terminal.output).not.toContain("Search models");
    });
  });

  it("treats cancelling the auth-method selector as cancellation and restores the editor", async () => {
    await withAuthTui({}, async ({ terminal, credentialStore }) => {
      terminal.type("/login anthropic");
      terminal.send("\r");
      await waitForOutput(terminal, "supports more than one");
      terminal.send("\x1b");
      await waitForOutput(terminal, "Login cancelled.");
      expect(terminal.output).not.toContain("No supported authentication method");
      await expect(credentialStore.list()).resolves.toEqual([]);
      terminal.type("/login openai");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      terminal.send("\x1b");
    });
  });

  it("retains a saved login and cached models when catalog refresh fails", async () => {
    await withAuthTui({ refreshModels: async () => { throw new Error("catalog unavailable"); } }, async ({ terminal, credentialStore }) => {
      terminal.type("/login openai");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      terminal.send("test-openai-secret\r");
      await waitForOutput(terminal, "Model catalog refresh failed for openai");
      await waitForOutput(terminal, "Search models");
      await expect(credentialStore.read("openai")).resolves.toMatchObject({ type: "api_key" });
      expect(terminal.output).toContain("Signed in to openai");
    });
  });

  it("lets logout choose a saved account independently of the current model", async () => {
    await withAuthTui({ model: "openai:test-model" }, async ({ terminal, credentialStore, session }) => {
      await credentialStore.modify("openai", async () => ({ type: "api_key", key: "retain-openai-key" }));
      await credentialStore.modify("anthropic", async () => ({ type: "api_key", key: "remove-anthropic-key" }));
      terminal.type("/logout");
      terminal.send("\r");
      await waitForOutput(terminal, "Search saved accounts");
      terminal.send("\x1b");
      await expect(credentialStore.list()).resolves.toHaveLength(2);
      const before = terminal.output.length;
      terminal.type("/logout");
      terminal.send("\r");
      await waitForCondition(async () => terminal.output.slice(before).includes("Search saved accounts"), "logout picker reopened");
      terminal.type("anthropic");
      terminal.send("\r");
      await waitForOutput(terminal, "Removed the saved anthropic credential");
      await expect(credentialStore.read("anthropic")).resolves.toBeUndefined();
      await expect(credentialStore.read("openai")).resolves.toMatchObject({ type: "api_key" });
      expect(session.model).toBe("openai:test-model");
      expect(terminal.output).not.toContain("retain-openai-key");
      expect(terminal.output).not.toContain("remove-anthropic-key");
    });
  });

  it("uses models discovered during login refresh instead of the empty startup catalog", async () => {
    let refreshed = false;
    await withAuthTui({
      refreshModels: async (provider) => { refreshed = provider === "openai"; },
      modelChoices: () => refreshed ? [{ value: "openai:discovered-model", label: "Discovered model" }] : [],
    }, async ({ terminal, session }) => {
      terminal.type("/login openai");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      terminal.send("test-openai-secret\r");
      await waitForOutput(terminal, "Discovered model");
      terminal.send("\r");
      await waitForCondition(async () => session.model === "openai:discovered-model", "refreshed model selection");
    });
  });

  it("returns to the editor when login succeeds but the provider has no available models", async () => {
    await withAuthTui({ modelChoices: [] }, async ({ terminal, credentialStore, session }) => {
      terminal.type("/login openai");
      terminal.send("\r");
      await waitForOutput(terminal, "openai API key input is hidden");
      terminal.send("test-openai-secret\r");
      await waitForOutput(terminal, "No models are available for openai yet");
      expect(session.model).toBe(UNCONFIGURED_MODEL);
      await expect(credentialStore.read("openai")).resolves.toMatchObject({ type: "api_key" });
      terminal.type("/logout");
      terminal.send("\r");
      await waitForOutput(terminal, "Search saved accounts");
      terminal.send("\r");
      await waitForOutput(terminal, "Removed the saved openai credential");
    });
  });

  it.each([
    ["/login", "Search providers"],
    ["/login anthropic", "supports more than one"],
    ["/logout", "Search saved accounts"],
  ])("settles the pending %s selector during SIGTERM shutdown", async (command, marker) => {
    await withAuthTui({}, async ({ terminal, credentialStore, running }) => {
      await credentialStore.modify("openai", async () => ({ type: "api_key", key: "test-one" }));
      await credentialStore.modify("anthropic", async () => ({ type: "api_key", key: "test-two" }));
      terminal.type(command);
      terminal.send("\r");
      await waitForOutput(terminal, marker);
      process.emit("SIGTERM", "SIGTERM");
      await expect(running).resolves.toBe(0);
      await expect(credentialStore.list()).resolves.toHaveLength(2);
    });
  });

  it("supports hidden /login and /logout without entering the Run transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-auth-"));
    const previousExitCode = process.exitCode;
    try {
      const mainModel = new ScriptedModel([]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted/main",
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, {
        mainModel,
        createRunId: () => "interactive-auth-run",
      });
      const credentialStore = new FileCredentialStore({
        filePath: join(root, "credentials.json"),
      });
      const authModel = createOpenRouterModelPort({
        credentials: credentialStore,
        authContext: {
          env: async () => undefined,
          fileExists: async () => false,
        },
      });
      let credentialSaved = false;
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        auth: {
          credentialStore,
          modelPort: authModel,
          environment: {},
          onChanged: async () => {
            credentialSaved = (await credentialStore.read("openrouter")) !== undefined;
          },
        },
        credentialStatus: () => ({
          provider: "openrouter",
          selectorRecognized: true,
          catalogKnown: true,
          credentialEnv: "OPENROUTER_API_KEY",
          credentialPresent: credentialSaved,
          ...(credentialSaved ? { credentialSource: "saved" as const } : {}),
          authStatus: "unverified" as const,
        }),
      });

      await terminal.started;
      terminal.type("/login");
      terminal.send("\r");
      await waitForOutput(terminal, "input is hidden");
      // Terminals wrap clipboard input in bracketed-paste markers. The
      // hidden prompt must store the payload without treating the ESC bytes
      // as cancellation.
      terminal.send("\x1b[200~tui-secret-value\x1b[201~");
      terminal.send("\r");
      await waitForCondition(
        async () => (await credentialStore.read("openrouter"))?.type === "api_key",
        "saved TUI credential",
      );
      await waitForOutput(terminal, "Signed in to openrouter");
      expect(terminal.output).not.toContain("tui-secret-value");
      expect(session.snapshot().runId).toBeUndefined();
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "saved credential (unverified)");

      terminal.type("/logout");
      terminal.send("\r");
      await waitForOutput(terminal, "Search saved accounts");
      terminal.send("\r");
      await waitForCondition(
        async () => (await credentialStore.read("openrouter")) === undefined,
        "removed TUI credential",
      );
      await waitForOutput(terminal, "No environment credential is configured");
      expect(mainModel.callCount).toBe(0);

      terminal.type("/login");
      terminal.send("\r");
      await waitForOutput(terminal, "input is hidden");
      terminal.send("\x1b");
      await waitForOutput(terminal, "Login cancelled.");
      await expect(credentialStore.read("openrouter")).resolves.toBeUndefined();

      terminal.type("/quit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows provider-owned auth sources in the login picker", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-providers-"));
    const previousExitCode = process.exitCode;
    try {
      const environment: NodeJS.ProcessEnv = { OPENAI_API_KEY: "provider-browser-key" };
      const credentialStore = new FileCredentialStore({
        filePath: join(root, "credentials.json"),
      });
      const modelPort = createBuiltinModelPort({
        credentials: credentialStore,
        authContext: {
          env: async (name) => environment[name],
          fileExists: async () => false,
        },
      });
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted/main",
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]), createRunId: () => "provider-browser-run" });
      const terminal = new MemoryTerminal(120, 36);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        auth: {
          credentialStore,
          modelPort,
          environment,
        },
      });

      await terminal.started;
      terminal.type("/login");
      terminal.send("\r");
      await waitForOutput(terminal, "Search providers");
      terminal.type("openai");
      await waitForOutput(terminal, "OpenAI");
      await waitForOutput(terminal, "ready locally");
      expect(normalizeTerminalOutput(terminal.output)).toContain("OPENAI_API_KEY");

      terminal.send("\x1b");
      await waitForOutput(terminal, "Login cancelled.");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders visible provider fields in the TUI login input without exposing secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-visible-auth-"));
    const previousExitCode = process.exitCode;
    try {
      const credentialStore = new FileCredentialStore({
        filePath: join(root, "credentials.json"),
      });
      const authModel: AuthModelPort = {
        providers: () => [{
          id: "demo",
          name: "Demo Provider",
          modelCount: 1,
          authTypes: ["api_key"],
          apiKeyName: "Demo API key",
        }],
        hasProvider: (provider) => provider === "demo",
        providerAuthTypes: () => ["api_key"],
        checkAuth: async () => undefined,
        logout: async () => {},
        login: async (_type, interaction) => {
          const key = await interaction.prompt({ type: "secret", message: "Enter demo API key" });
          const account = await interaction.prompt({ type: "text", message: "Enter demo account id" });
          expect(key).toBe("hidden-demo-key");
          expect(account).toBe("account-visible");
          return { type: "api_key", key };
        },
      };
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted/main",
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]), createRunId: () => "visible-auth-run" });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        auth: {
          credentialStore,
          modelPort: authModel,
          provider: "demo",
          environment: {},
        },
      });

      await terminal.started;
      terminal.type("/login");
      terminal.send("\r");
      await waitForOutput(terminal, "input is hidden");
      terminal.send("hidden-demo-key\r");
      await waitForOutput(terminal, "Enter demo account id");
      terminal.send("account-visible\r");
      await waitForOutput(terminal, "Signed in to demo");
      expect(normalizeTerminalOutput(terminal.output)).toContain("account-visible");
      expect(terminal.output).not.toContain("hidden-demo-key");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a hidden login prompt when the TUI receives SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-auth-signal-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted/main",
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]), createRunId: () => "auth-signal-run" });
      const credentialStore = new FileCredentialStore({
        filePath: join(root, "credentials.json"),
      });
      const authModel = createOpenRouterModelPort({
        credentials: credentialStore,
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        auth: {
          credentialStore,
          modelPort: authModel,
          environment: {},
        },
      });

      await terminal.started;
      terminal.type("/login");
      terminal.send("\r");
      await waitForOutput(terminal, "input is hidden");
      process.emit("SIGTERM", "SIGTERM");
      await expect(running).resolves.toBe(0);
      await expect(credentialStore.read("openrouter")).resolves.toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Teto's sibling transcript out of the Main presentation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-teto-transcript-"));
    const previousExitCode = process.exitCode;
    try {
      const mainModel = new ScriptedModel([response("MAIN_ANSWER_SENTINEL")]);
      const tetoModel = new ScriptedModel([response("TETO_ANSWER_SENTINEL")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted/main",
        tetoModel: "scripted/teto",
        policy: {
          maxMainStepsPerActivation: 2,
          maxModelTokens: 10_000,
          tetoEnabled: true,
          tetoActivation: "automatic",
          tetoMaxOutputTokens: 64,
          tetoTokenRatio: 0.1,
        },
      }, {
        mainModel,
        tetoModel,
        createRunId: () => "interactive-teto-transcript-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("hello");
      terminal.send("\r");
      await session.waitForIdle();
      await waitForOutput(terminal, "MAIN_ANSWER_SENTINEL");
      await waitForCondition(
        () => tetoModel.callCount > 0,
        "Teto sibling activation",
      );
      await delay(40);

      const visible = normalizeTerminalOutput(terminal.output);
      expect(visible).toContain("MAIN_ANSWER_SENTINEL");
      expect(visible).not.toContain("TETO_ANSWER_SENTINEL");
      expect(visible).not.toContain("Main output:");
      await expect(session.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "hello" }),
        expect.objectContaining({ role: "assistant", content: "MAIN_ANSWER_SENTINEL" }),
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders external A2A payloads as Prime-style agent messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-external-a2a-"));
    const previousExitCode = process.exitCode;
    const runId = "interactive-external-a2a-target";
    try {
      const seed = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("seeded")]),
        createRunId: () => runId,
      });
      await seed.submit({ inputId: "seed-input", text: "seed" });
      await seed.waitForIdle();
      await seed.close();

      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId,
        sessionId: "target-session",
      }, {
        mainModel: new ScriptedModel([]),
      });
      const terminal = new MemoryTerminal(120, 36);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      const payloads: A2AMessage["payload"][] = [
        {
          type: "message.inform",
          text: "inform line one\ninform line two",
        },
        {
          type: "question.ask",
          question: "Which evidence should be checked first?",
        },
        {
          type: "question.answer",
          answer: "Start with the WindowServer watchdog report.",
        },
        {
          type: "task.request",
          taskId: "external-task-1",
          goal: {
            version: 1,
            statement: "Inspect the external task and report the result",
            successCriteria: [],
            hardConstraints: [],
          },
          inputRefs: [],
          budget: { maxModelTokens: 100, maxWallClockMs: 1_000 },
        },
        {
          type: "advice.propose",
          advice: {
            adviceId: "external-advice-1",
            kind: "orientation",
            claim: "The external evidence points to a stale dependency",
            evidenceRefs: [],
            confidence: 0.8,
            risk: "low",
            suggestedAction: "Reproduce with a clean dependency graph",
            urgency: "next-step",
            expiresAt,
            dedupeKey: "external-advice-1",
            sourceLane: "main",
          },
        },
      ];
      for (const [index, payload] of payloads.entries()) {
        const message = externalA2AMessage({
          runId,
          sourceRunId: "source-session-with-a-very-long-name",
          sourceSessionId: "source-session",
          targetSessionId: "target-session",
          payload,
          createdAt,
          expiresAt,
          index,
        });
        const event: Extract<AnyEvent, { type: "message.sent" }> = {
          eventId: `external-event-${index}`,
          runId,
          laneId: "main",
          globalOffset: 10 + index,
          laneSeq: 10 + index,
          type: "message.sent",
          schemaVersion: 1,
          occurredAt: createdAt,
          correlationId: message.correlationId,
          idempotencyKey: `a2a:send:${message.routeId}:${message.idempotencyKey}`,
          visibility: message.visibility,
          contentHash: `test-hash-${index}`,
          payload: { message },
        };
        (session as unknown as {
          publish: (runtimeEvent: SessionRuntimeEvent) => void;
        }).publish({ kind: "event", event });
      }

      await waitForOutput(terminal, "Agent message received");
      await waitForOutput(terminal, "from source-session");
      expect(terminal.output).not.toContain("source-session-with-a-very-long-name");
      const visible = normalizeTerminalOutput(terminal.output);
      expect(visible).not.toContain("Source endpoint:");
      expect(visible).toContain("inform line one inform line two");
      expect(visible).toContain("to target-session");
      expect(visible).toContain("Which evidence should be");
      expect(visible).toContain("Start with the WindowServer");
      terminal.send("\x10");
      await waitForOutput(terminal, "Which evidence should be checked first?");
      const expanded = normalizeTerminalOutput(terminal.output);
      expect(expanded).toContain("Start with the WindowServer watchdog report.");
      expect(expanded).toContain("Inspect the external task and report the result");
      expect(expanded).toContain("The external evidence points to a stale dependency");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["live", "resume"])("renders public in-Run A2A directions in the %s transcript", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-lane-messages-"));
    const dataDir = join(root, "state");
    const runId = "interactive-lane-messages";
    const previousExitCode = process.exitCode;
    try {
      const seed = await SessionController.open({
        workspace: root, dataDir, model: "scripted",
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([response("Main answer")]), createRunId: () => runId });
      await seed.submit({ inputId: "seed", text: "Seed task" });
      await seed.waitForIdle();
      await seed.close();

      const now = new Date().toISOString();
      const records: Array<{ from: string; to: string; payload: A2AMessage["payload"]; visibility?: "lane" | "sensitive" }> = [
        { from: "teto", to: "main", payload: { type: "message.inform", text: "TETO_PUBLIC_NOTE" } },
        { from: "main", to: "teto", payload: { type: "question.ask", question: "MAIN_PUBLIC_QUESTION" } },
        { from: "team:r:a", to: "team:r:b", payload: { type: "question.answer", answer: "PEER_PUBLIC_ANSWER" } },
        { from: "teto", to: "main", payload: { type: "message.inform", text: "TETO_PRIVATE_NOTE" }, visibility: "lane" },
        { from: "main", to: "teto", payload: { type: "message.inform", text: "MAIN_SENSITIVE_NOTE" }, visibility: "sensitive" },
        { from: "teto", to: "main", payload: { type: "task.accept", taskId: "HIDDEN_TASK_PROTOCOL" } },
      ];
      const events: Array<Extract<AnyEvent, { type: "message.sent" }>> = records.map((record, index) => {
        const id = `lane-message-${index}`;
        const message: A2AMessage = {
          messageId: id, runId, from: record.from, to: record.to, payload: record.payload,
          createdAt: now, visibility: record.visibility ?? "run", priority: 5, delivery: "next-step",
          conversationId: runId, threadId: id, correlationId: id, idempotencyKey: id,
        };
        return {
          eventId: id, runId, laneId: record.from, globalOffset: 100 + index, laneSeq: 100 + index,
          type: "message.sent", schemaVersion: 1, occurredAt: now, correlationId: id,
          idempotencyKey: id, visibility: message.visibility, contentHash: `test:${id}`, payload: { message },
        };
      });
      if (mode === "resume") {
        const ledger = await JsonlLedger.open(join(dataDir, "runs", runId, "ledger.jsonl"));
        for (const event of events) await ledger.append({
          runId, laneId: event.laneId, type: "message.sent", payload: event.payload,
          correlationId: event.correlationId, idempotencyKey: event.idempotencyKey, visibility: event.visibility,
        });
        await ledger.close();
      }
      const model = new ScriptedModel([]);
      const session = await SessionController.open({ workspace: root, dataDir, model: "scripted", runId }, { mainModel: model });
      const terminal = new MemoryTerminal(140, 44);
      const running = runInteractive({ session, terminal, forceAltScreen: true });
      await terminal.started;
      await waitForOutput(terminal, "Main answer");
      if (mode === "live") {
        const publish = (session as unknown as { publish: (event: SessionRuntimeEvent) => void }).publish.bind(session);
        for (const event of [...events, events[0]!]) publish({ kind: "event", event });
      }
      await waitForOutput(terminal, "TETO_PUBLIC_NOTE");
      await waitForOutput(terminal, "MAIN_PUBLIC_QUESTION");
      await waitForOutput(terminal, "PEER_PUBLIC_ANSWER");
      const visible = normalizeTerminalOutput(terminal.output);
      expect(visible).toContain("from teto to main");
      expect(visible).toContain("Agent message sent");
      expect(visible).toContain("from main to teto");
      expect(visible).toContain("from team:r:a to team:r:b");
      expect(visible).not.toContain("TETO_PRIVATE_NOTE");
      expect(visible).not.toContain("MAIN_SENSITIVE_NOTE");
      expect(visible).not.toContain("HIDDEN_TASK_PROTOCOL");
      expect(model.callCount).toBe(0);
      if (mode === "resume") {
        expect((await session.transcript()).filter((entry) => entry.role === "agent")).toHaveLength(3);
      }
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats same-tick Enter submissions as steering and preserves explicit follow-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queue-delivery-"));
    const previousExitCode = process.exitCode;
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("STEERING_ANSWER"),
        response("FOLLOW_UP_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 3, tetoEnabled: false },
      }, { mainModel: model, createRunId: () => "interactive-queue-delivery-run" });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("first");
      terminal.send("\r");
      // No await here: the second Enter arrives before SessionController's
      // admission microtask has published its running state.
      terminal.type("second");
      terminal.send("\r");
      terminal.type("third");
      terminal.send("\x1b\r");
      await waitForPendingInputs(session, 2);

      const pending = await session.pendingInputs();
      expect(pending.map((input) => input.delivery)).toEqual(["steering", "follow-up"]);

      releaseFirst(response("FIRST_ANSWER"));
      await waitForModelCalls(model, 3);
      await waitForOutput(terminal, "FOLLOW_UP_ANSWER");
      const admissions = events
        .filter((event): event is Extract<SessionRuntimeEvent, { kind: "event" }> => event.kind === "event")
        .map((event) => event.event)
        .filter((event): event is Extract<typeof event, { type: "input.admitted" }> => event.type === "input.admitted");
      expect(admissions.map((event) => event.payload.delivery)).toEqual([
        "new-turn",
        "steering",
        "follow-up",
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("browses, edits, changes lane, and withdraws durable queued input", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queue-edit-"));
    const previousExitCode = process.exitCode;
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("STEERING_AFTER_EDIT"),
        response("FOLLOW_UP_AFTER_EDIT"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 3, tetoEnabled: false },
      }, { mainModel: model, createRunId: () => "interactive-queue-edit-run" });
      const originalSubscribe = session.subscribe.bind(session);
      const originalPendingInputs = session.pendingInputs.bind(session);
      let forwardRuntimeEvents = true;
      let markInitialQueueRead = (): void => {};
      const initialQueueRead = new Promise<void>((resolve) => { markInitialQueueRead = resolve; });
      let pendingInputReads = 0;
      (session as unknown as {
        subscribe: typeof session.subscribe;
        pendingInputs: typeof session.pendingInputs;
      }).subscribe = (listener) => originalSubscribe((event) => {
        if (forwardRuntimeEvents) listener(event);
      });
      (session as unknown as {
        pendingInputs: typeof session.pendingInputs;
      }).pendingInputs = async () => {
        const pending = await originalPendingInputs();
        pendingInputReads += 1;
        if (pendingInputReads === 1) markInitialQueueRead();
        return pending;
      };
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await initialQueueRead;
      // Force the local preview to remain stale. Alt+Up must query the durable
      // projection itself instead of depending on event presentation timing.
      forwardRuntimeEvents = false;
      terminal.type("active");
      terminal.send("\r");
      await waitForModelCalls(model, 1);
      terminal.type("older steering");
      terminal.send("\r");
      terminal.type("newer follow-up");
      terminal.send("\x1b\r");
      await waitForPendingInputs(session, 2);

      terminal.type("untouched draft");
      const readsBeforeBrowse = pendingInputReads;
      terminal.send("\x1b[1;3A");
      await waitForOutput(terminal, "editing follow-up");
      expect(pendingInputReads).toBeGreaterThan(readsBeforeBrowse);
      forwardRuntimeEvents = true;
      terminal.send("\x15");
      terminal.type("newer edited");
      terminal.send("\r");
      await waitForCondition(async () => {
        const pending = await session.pendingInputs();
        return pending.some((item) => (
          item.text === "newer edited" && item.delivery === "steering"
        ));
      }, "queued input replacement");

      // A successful mutation returns to the draft that was present before browsing.
      terminal.send("\r");
      await waitForCondition(async () => (
        (await session.pendingInputs()).some((item) => item.text === "untouched draft")
      ), "restored draft submission");

      // The restored draft is newest; an empty submission withdraws it durably.
      const withdrawalBrowseFrames = countOccurrences(terminal.output, "editing steering");
      terminal.send("\x1b[1;3A");
      await waitForCondition(
        () => countOccurrences(terminal.output, "editing steering") > withdrawalBrowseFrames,
        "queued input selection for withdrawal",
      );
      terminal.send("\x15");
      terminal.send("\r");
      await waitForCondition(async () => (
        !(await session.pendingInputs()).some((item) => item.text === "untouched draft")
      ), "queued input withdrawal");

      // Alt+Enter while browsing moves the selected input to the follow-up lane.
      const laneBrowseFrames = countOccurrences(terminal.output, "editing steering");
      terminal.send("\x1b[1;3A");
      await waitForCondition(
        () => countOccurrences(terminal.output, "editing steering") > laneBrowseFrames,
        "queued input selection for lane change",
      );
      terminal.send("\x1b\r");
      await waitForCondition(async () => {
        const pending = await session.pendingInputs();
        return pending.some((item) => (
          item.text === "newer edited" && item.delivery === "follow-up"
        ));
      }, "queued input lane change");

      releaseFirst(response("ACTIVE_ANSWER"));
      await waitForOutput(terminal, "FOLLOW_UP_AFTER_EDIT");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });

  it("admits queued Enter input before a concurrent /exit closes the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queue-exit-"));
    const previousExitCode = process.exitCode;
    let releaseAdmission = (): void => {};
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("QUEUED_INPUT_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model, createRunId: () => "interactive-queue-exit-run" });
      const originalSubmit = session.submit.bind(session);
      let holdFirstAdmission = true;
      (session as unknown as {
        submit: typeof session.submit;
      }).submit = async (request) => {
        if (holdFirstAdmission) {
          holdFirstAdmission = false;
          await admissionGate;
        }
        return originalSubmit(request);
      };
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("first");
      terminal.send("\r");
      terminal.type("queued before exit");
      terminal.send("\r");
      terminal.type("/exit");
      terminal.send("\r");
      await delay(40);
      expect(model.callCount).toBe(0);

      releaseFirst(response("FIRST_ANSWER"));
      releaseAdmission();
      await expect(running).resolves.toBe(0);

      const admissions = events
        .filter((event): event is Extract<SessionRuntimeEvent, { kind: "event" }> => event.kind === "event")
        .map((event) => event.event)
        .filter((event): event is Extract<typeof event, { type: "input.admitted" }> => event.type === "input.admitted");
      expect(admissions).toHaveLength(2);
      expect(admissions.map((event) => event.payload.delivery)).toEqual(["new-turn", "steering"]);
    } finally {
      releaseAdmission();
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "Ctrl+D",
      expectedCode: 0,
      trigger: (terminal: MemoryTerminal): void => { terminal.send("\x04"); },
    },
    {
      name: "two idle Ctrl+C presses after clearing the draft",
      expectedCode: 130,
      trigger: (terminal: MemoryTerminal): void => {
        terminal.type("discard this draft");
        terminal.send("\x03");
        terminal.send("\x03");
        terminal.send("\x03");
      },
    },
    {
      name: "SIGTERM",
      expectedCode: 0,
      trigger: (_terminal: MemoryTerminal): void => {
        process.emit("SIGTERM", "SIGTERM");
      },
    },
    {
      name: "SIGINT",
      expectedCode: 130,
      trigger: (_terminal: MemoryTerminal): void => {
        process.emit("SIGINT", "SIGINT");
      },
    },
  ])("admits accepted input before $name shutdown", async ({ expectedCode, trigger }) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-signal-exit-"));
    const previousExitCode = process.exitCode;
    let releaseAdmission = (): void => {};
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let markSubmitStarted = (): void => {};
    const submitStarted = new Promise<void>((resolve) => { markSubmitStarted = resolve; });
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("answer")]),
        createRunId: () => "interactive-signal-exit-run",
      });
      const originalSubmit = session.submit.bind(session);
      (session as unknown as { submit: typeof session.submit }).submit = async (request) => {
        markSubmitStarted();
        await admissionGate;
        return originalSubmit(request);
      };
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });
      let exited = false;
      void running.then(() => { exited = true; });

      await terminal.started;
      terminal.type("persist before shutdown");
      terminal.send("\r");
      await submitStarted;
      trigger(terminal);
      await delay(40);
      expect(exited).toBe(false);

      releaseAdmission();
      await expect(running).resolves.toBe(expectedCode);
      expect(events.some((event) =>
        event.kind === "event" && event.event.type === "input.admitted"
      )).toBe(true);
    } finally {
      releaseAdmission();
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires two idle Ctrl+C presses within the exit window", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-double-interrupt-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        interruptExitWindowMs: 100,
      });
      let exited = false;
      void running.then(() => { exited = true; });

      await terminal.started;
      terminal.send("\x03");
      await waitForOutput(terminal, "Press Ctrl+C again to exit");
      await delay(20);
      expect(exited).toBe(false);

      terminal.send("\x03");
      await expect(running).resolves.toBe(130);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expires the idle Ctrl+C exit window", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-interrupt-timeout-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        interruptExitWindowMs: 20,
      });
      let exited = false;
      void running.then(() => { exited = true; });

      await terminal.started;
      terminal.send("\x03");
      await delay(50);
      terminal.send("\x03");
      await delay(10);
      expect(exited).toBe(false);

      terminal.send("\x03");
      await expect(running).resolves.toBe(130);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Ctrl+C to cancel a running Turn without closing the TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-running-interrupt-"));
    const previousExitCode = process.exitCode;
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("AFTER_CANCEL_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("cancel this turn");
      terminal.send("\r");
      await waitForModelCalls(model, 1);
      terminal.send("\x03");
      await waitForCondition(
        () => session.snapshot().status !== "running" && session.snapshot().status !== "cancelling",
        "cancelled Turn to settle",
      );

      terminal.type("continue after cancel");
      terminal.send("\r");
      await waitForOutput(terminal, "AFTER_CANCEL_ANSWER");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows shortcut help for an empty '?' but preserves '?' in normal input", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-shortcut-help-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([response("QUESTION_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.send("?");
      await waitForOutput(terminal, "Prompt");
      expect(terminal.output).toContain("Ctrl+S");
      expect(model.callCount).toBe(0);

      terminal.type("why?");
      terminal.send("\r");
      await waitForOutput(terminal, "QUESTION_ANSWER");
      expect(model.requests[0]?.messages.at(-1))
        .toMatchObject({ role: "user", content: "why?" });

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stashes and restores an image draft with Ctrl+S without submitting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-prompt-stash-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([response("STASH_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({
          bytes: TINY_PNG,
          mimeType: "image/png",
        }),
      });

      await terminal.started;
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #1]");
      terminal.type(" draft to keep for later");
      terminal.send("\x13");
      await waitForOutput(terminal, "Stashed prompt");
      expect(model.callCount).toBe(0);

      terminal.type("do not replace the stash");
      terminal.send("\x13");
      await waitForOutput(terminal, "Prompt stash already has a draft");
      terminal.send("\x03");

      // Ctrl+S on an empty editor restores the exact draft, which can then be
      // submitted normally.
      terminal.send("\x13");
      await waitForOutput(terminal, "Restored stashed prompt");
      terminal.send("\r");
      await waitForOutput(terminal, "STASH_ANSWER");
      expect(model.requests[0]?.messages.at(-1))
        .toMatchObject({
          role: "user",
          content: "[image #1] draft to keep for later",
          images: [{ mimeType: "image/png", data: TINY_PNG.toString("base64") }],
        });

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies the last assistant answer through the injected clipboard writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-copy-"));
    const previousExitCode = process.exitCode;
    const copied: string[] = [];
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([response("COPY_SENTINEL")]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardTextWriter: async (text) => { copied.push(text); },
      });

      await terminal.started;
      terminal.type("answer first");
      terminal.send("\r");
      await waitForOutput(terminal, "COPY_SENTINEL");
      terminal.type("/copy");
      terminal.send("\r");
      await waitForOutput(terminal, "Copied last assistant message");
      expect(copied).toEqual(["COPY_SENTINEL"]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the platform-specific clipboard shortcut in help contracts", () => {
    expect(clipboardImagePasteKey("win32")).toBe("alt+v");
    expect(clipboardImagePasteKey("darwin")).toBe("ctrl+v");
    expect(clipboardImagePasteKey("linux")).toBe("ctrl+v");
  });

  it("mounts a fixed alternate-screen surface and restores the terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });

      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
      });
      await terminal.started;
      await delay(120);
      terminal.type("/exit");
      terminal.send("\r");
      const result = await running;

      expect(result).toBe(0);
      expect(terminal.output).toContain("\x1b[?1049h");
      expect(terminal.output).toContain("\x1b[?1049l");
      expect(terminal.output).not.toContain("\x1b[48;2;232;232;232m");
      const plainOutput = stripTerminalSequences(terminal.output);
      expect(plainOutput).toContain("Nausicaa v0.1.0");
      expect(plainOutput).toContain("escape interrupt");
      expect(plainOutput).toContain("ctrl+o more");
      expect(plainOutput).toContain("Press ctrl+o to show full startup help");
      expect(plainOutput).toContain("Nausicaa can explain its own features");
      expect(plainOutput).not.toContain("cwd");
      expect(plainOutput).not.toContain("Ctrl+E");
      expect(terminal.cursorVisible).toBe(true);
      expect(exitFrame(terminal.output)).not.toContain('Try "inspect this project"');
      expect(exitFrame(terminal.output)).not.toContain("← main");
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("submits and restores image-only turns without rendering image data", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-"));
    const previousExitCode = process.exitCode;
    const image = {
      type: "image" as const,
      data: Buffer.from("private-image-bytes").toString("base64"),
      mimeType: "image/png",
    };
    try {
      const model = new ScriptedModel([response("IMAGE_ONLY_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-image-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        initialImages: [image],
      });

      await terminal.started;
      await completed;
      await waitForOutput(terminal, "IMAGE_ONLY_ANSWER");
      await waitForOutput(terminal, "1 image");
      expect(terminal.output).toContain("PNG");
      expect(terminal.output).not.toContain(image.data);
      expect(model.requests[0]?.messages.find((message) =>
        message.role === "user" && message.images !== undefined
      )).toMatchObject({ content: "", images: [image] });

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);

      process.exitCode = previousExitCode;
      const reopened = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId: "interactive-image-run",
      });
      const restoredTerminal = new MemoryTerminal(100, 28);
      const restored = runInteractive({
        session: reopened,
        terminal: restoredTerminal,
        forceAltScreen: true,
      });
      await restoredTerminal.started;
      await waitForOutput(restoredTerminal, "1 image");
      expect(restoredTerminal.output).toContain("PNG");
      expect(restoredTerminal.output).toContain("IMAGE_ONLY_ANSWER");
      expect(restoredTerminal.output).not.toContain(image.data);
      restoredTerminal.type("/exit");
      restoredTerminal.send("\r");
      await expect(restored).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an image draft when the selected model is text-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-text-only-image-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "text-only",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new TextOnlyScriptedModel([]),
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        initialImages: [{ type: "image", mimeType: "image/png", data: TINY_PNG.toString("base64") }],
      });

      await terminal.started;
      await waitForOutput(terminal, "selected model does not support image input");
      expect(session.snapshot().status).toBe("detached");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Prime-style clipboard markers for image-only, history, and deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-clipboard-image-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([
        response("PASTED_IMAGE_ANSWER"),
        response("HISTORY_IMAGE_ANSWER"),
        response("TEXT_ONLY_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-clipboard-image-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({
          bytes: TINY_PNG,
          mimeType: "image/png",
        }),
      });

      await terminal.started;
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #1]");
      terminal.send("\r");
      await waitForModelCalls(model, 1);
      await waitForOutput(terminal, "PASTED_IMAGE_ANSWER");

      expect(model.requests[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "[image #1]",
        images: [{ mimeType: "image/png", data: TINY_PNG.toString("base64") }],
      });

      terminal.send("\x1b[A");
      terminal.send("\r");
      await waitForModelCalls(model, 2);
      await waitForOutput(terminal, "HISTORY_IMAGE_ANSWER");
      expect(model.requests[1]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "[image #1]",
        images: [{ mimeType: "image/png" }],
      });

      terminal.send("\x1b[A");
      terminal.send("\x0b");
      terminal.type("text only");
      terminal.send("\r");
      await waitForModelCalls(model, 3);
      await waitForOutput(terminal, "TEXT_ONLY_ANSWER");
      const lastUser = model.requests[2]?.messages.filter((message) => message.role === "user").at(-1);
      if (lastUser?.role !== "user") throw new Error("missing final user message");
      expect(lastUser).toMatchObject({ role: "user", content: "text only" });
      expect(lastUser.images).toBeUndefined();
      expect(terminal.output).not.toContain(TINY_PNG.toString("base64"));

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rebind restored image markers after a process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-restart-"));
    const previousExitCode = process.exitCode;
    try {
      const firstModel = new ScriptedModel([response("FIRST_IMAGE_ANSWER")]);
      const firstSession = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: firstModel,
        createRunId: () => "interactive-image-restart-run",
      });
      const firstTerminal = new MemoryTerminal(100, 28);
      const firstRunning = runInteractive({
        session: firstSession,
        terminal: firstTerminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
      });
      await firstTerminal.started;
      firstTerminal.send("\x16");
      await waitForOutput(firstTerminal, "[image #1]");
      firstTerminal.send("\r");
      await waitForOutput(firstTerminal, "FIRST_IMAGE_ANSWER");
      firstTerminal.type("/exit");
      firstTerminal.send("\r");
      await expect(firstRunning).resolves.toBe(0);

      process.exitCode = previousExitCode;
      const secondBytes = Buffer.from([9, 8, 7]);
      const secondModel = new ScriptedModel([response("SECOND_IMAGE_ANSWER")]);
      const secondSession = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId: "interactive-image-restart-run",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: secondModel });
      const secondTerminal = new MemoryTerminal(100, 28);
      const secondRunning = runInteractive({
        session: secondSession,
        terminal: secondTerminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: secondBytes, mimeType: "image/png" }),
      });
      await secondTerminal.started;
      secondTerminal.send("\x16");
      await waitForOutput(secondTerminal, "[image #2]");
      secondTerminal.send("\r");
      await waitForOutput(secondTerminal, "SECOND_IMAGE_ANSWER");
      expect(secondModel.requests[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "[image #2]",
        images: [{ data: secondBytes.toString("base64") }],
      });

      secondTerminal.send("\x1b[A");
      secondTerminal.send("\x1b[A");
      secondTerminal.send("\r");
      await waitForOutput(secondTerminal, "no longer available");
      expect(secondModel.callCount).toBe(1);

      secondTerminal.send("\x15");
      secondTerminal.type("/exit");
      secondTerminal.send("\r");
      await expect(secondRunning).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves literal markers and blocks unresolved references", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-literal-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
      });

      await terminal.started;
      terminal.type("literal [image #1] ");
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #2]");
      terminal.send("\r");
      await waitForOutput(terminal, "no longer available");
      expect(model.callCount).toBe(0);

      terminal.send("\x15");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evicts unprotected history images and reports expired markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-eviction-"));
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([response("FIRST_EVICTION_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: model });
      const terminal = new MemoryTerminal(100, 28);
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
        pastedImageBudgetBytes: TINY_PNG.byteLength,
      });

      await terminal.started;
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #1]");
      terminal.send("\r");
      await completed;
      await waitForOutput(terminal, "FIRST_EVICTION_ANSWER");

      terminal.send("\x16");
      await waitForOutput(terminal, "[image #2]");
      terminal.send("\x15");
      terminal.send("\x1b[A");
      terminal.send("\r");
      await waitForOutput(terminal, "no longer available");
      expect(model.callCount).toBe(1);

      terminal.send("\x15");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes clipboard reads and cancels attachment when the draft changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-race-"));
    const previousExitCode = process.exitCode;
    const reads = [
      deferredClipboardImage(),
      deferredClipboardImage(),
      deferredClipboardImage(),
    ];
    let readIndex = 0;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: () => {
          const read = reads[readIndex];
          readIndex += 1;
          if (read === undefined) throw new Error("unexpected clipboard read");
          return read.promise;
        },
      });

      await terminal.started;
      terminal.send("\x16");
      terminal.send("\x16");
      await waitForCondition(() => readIndex === 1, "first serialized clipboard read");
      reads[0]?.resolve({ bytes: TINY_PNG, mimeType: "image/png" });
      await waitForOutput(terminal, "[image #1]");
      await waitForCondition(() => readIndex === 2, "second serialized clipboard read");
      reads[1]?.resolve({ bytes: TINY_PNG, mimeType: "image/png" });
      await waitForOutput(terminal, "[image #2]");

      terminal.send("\x16");
      await waitForCondition(() => readIndex === 3, "third clipboard read");
      terminal.type("draft changed");
      reads[2]?.resolve({ bytes: TINY_PNG, mimeType: "image/png" });
      await waitForOutput(terminal, "draft changed while the clipboard");
      expect(terminal.output).not.toContain("[image #3]");

      terminal.send("\x03");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks clipboard byte size before base64 encoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-image-size-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({
          bytes: new Uint8Array(3 * 1024 * 1024 + 1),
          mimeType: "image/png",
        }),
      });

      await terminal.started;
      terminal.send("\x16");
      await waitForOutput(terminal, "exceeds the 3 MiB limit");
      expect(terminal.output).not.toContain("[image #1]");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves pasted images through steering and follow-up queues", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queued-image-"));
    const previousExitCode = process.exitCode;
    let releaseFirst = (_response: ModelResponse): void => {};
    const firstResponse = new Promise<ModelResponse>((resolve) => { releaseFirst = resolve; });
    try {
      const model = new ScriptedModel([
        async () => firstResponse,
        response("STEERED_IMAGE_ANSWER"),
        response("FOLLOW_UP_IMAGE_ANSWER"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 3, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-queued-image-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        clipboardImageReader: async () => ({ bytes: TINY_PNG, mimeType: "image/png" }),
      });

      await terminal.started;
      terminal.type("start main work");
      terminal.send("\r");
      await waitForModelCalls(model, 1);

      terminal.type("steer with image ");
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #1]");
      terminal.send("\r");
      terminal.type("follow up with image ");
      terminal.send("\x16");
      await waitForOutput(terminal, "[image #2]");
      terminal.send("\x1b\r");
      await waitForPendingInputs(session, 2);

      releaseFirst(response("FIRST_BOUNDARY"));
      await waitForModelCalls(model, 3);
      await waitForOutput(terminal, "FOLLOW_UP_IMAGE_ANSWER");

      const steering = model.requests[1]?.messages.findLast((message) =>
        message.role === "user" && message.content.includes("steer with image")
      );
      const followUp = model.requests[2]?.messages.findLast((message) =>
        message.role === "user" && message.content.includes("follow up with image")
      );
      if (steering?.role !== "user" || followUp?.role !== "user") {
        throw new Error("missing queued image messages");
      }
      expect(steering.images).toEqual([
        expect.objectContaining({ mimeType: "image/png", data: TINY_PNG.toString("base64") }),
      ]);
      expect(followUp.images).toEqual([
        expect.objectContaining({ mimeType: "image/png", data: TINY_PNG.toString("base64") }),
      ]);
      expect(terminal.output).not.toContain(TINY_PNG.toString("base64"));

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseFirst(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows and explicitly revises the persistent thread Goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-goal-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        createRunId: () => "interactive-goal-run",
      });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("/goal Understand this repository");
      terminal.send("\r");
      await waitForOutput(terminal, "Goal created.");
      terminal.type("/goal edit Explain installation precisely");
      terminal.send("\r");
      await waitForOutput(terminal, "Goal updated.");

      expect(session.snapshot().goal).toMatchObject({
        revision: 2,
        objective: "Explain installation precisely",
      });
      expect(events
        .filter((event) => event.kind === "event" && event.event.type === "thread.goal.changed"))
        .toHaveLength(2);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["/context"])(
    "renders %s locally without model or Ledger mutation",
    async (command) => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-context-"));
    const terminal = new MemoryTerminal(60, 28);
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-context-run",
      });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type(command);
      terminal.send("\r");
      await waitForOutput(terminal, "Cumulative usage");
      expect(terminal.output).toContain("Current context:");
      expect(terminal.output).toContain("not measured yet");
      expect(model.callCount).toBe(0);
      expect(events.filter((event) => event.kind === "event")).toHaveLength(0);

      if (command === "/context") {
        terminal.type("/context extra");
        terminal.send("\r");
        await waitForOutput(terminal, "Usage: /context");
        expect(model.callCount).toBe(0);
        expect(events.filter((event) => event.kind === "event")).toHaveLength(0);
      }

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["/agents", "/topology", "/list-agents"])(
    "renders %s as a read-only Awareness topology",
    async (command) => {
      const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-awareness-"));
      const terminal = new MemoryTerminal(100, 28);
      const previousExitCode = process.exitCode;
      try {
        const model = new ScriptedModel([]);
        const session = await SessionController.open({
          workspace: root,
          dataDir: join(root, "state"),
          model: "scripted",
          policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
        }, {
          mainModel: model,
          createRunId: () => "interactive-awareness-run",
        });
        const events: SessionRuntimeEvent[] = [];
        session.subscribe((event) => events.push(event));
        const running = runInteractive({
          session,
          terminal,
          forceAltScreen: true,
          awareness: {
            now: "2026-09-01T12:00:00.000Z",
            records: [{
              endpoint: {
                workspaceId: "repo",
                sessionId: "session-a",
                runId: "awareness-run",
                laneId: "main",
              },
              state: "running",
              lastSeen: "2026-09-01T12:00:00.000Z",
              activitySummary: "reviewing topology",
            }],
          },
        });

        await terminal.started;
        terminal.type(command);
        terminal.send("\r");
        await waitForOutput(terminal, "Nausicaa awareness");
        expect(terminal.output).toContain("run:awareness-run");
        expect(terminal.output).toContain("session:session-a");
        expect(terminal.output).toContain("reviewing topology");
        expect(model.callCount).toBe(0);
        expect(events.filter((event) => event.kind === "event")).toHaveLength(0);

        terminal.type(`${command} extra`);
        terminal.send("\r");
        await waitForOutput(terminal, "Usage: /list-agents");
        expect(model.callCount).toBe(0);
        expect(events.filter((event) => event.kind === "event")).toHaveLength(0);

        terminal.type("/exit");
        terminal.send("\r");
        await expect(running).resolves.toBe(0);
      } finally {
        process.exitCode = previousExitCode;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("shows only the canonical list-agents command in the slash menu", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-command-menu-"));
    const terminal = new MemoryTerminal(60, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const running = runInteractive({ session, terminal, forceAltScreen: true });
      await terminal.started;
      terminal.type("/");
      await waitForOutput(terminal, "list-agents");
      expect(terminal.output).not.toContain("/agents");
      expect(terminal.output).not.toContain("/topology");
      terminal.send("\x1b");
      terminal.send("\x03");
      terminal.type("/exit");
      terminal.send("\x1b");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unavailable Awareness without mutating the Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-awareness-unavailable-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-awareness-unavailable-run",
      });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/agents");
      terminal.send("\r");
      await waitForOutput(terminal, "Agent awareness is unavailable");
      expect(model.callCount).toBe(0);
      expect(events.filter((event) => event.kind === "event")).toHaveLength(0);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([44, 100])(
    "completes command arguments and preserves a multiline Goal at %i columns",
    async (columns) => {
      const root = await mkdtemp(join(tmpdir(), `nausicaa-tui-command-arguments-${columns}-`));
      const terminal = new MemoryTerminal(columns, 28);
      const previousExitCode = process.exitCode;
      try {
        const session = await SessionController.open({
          workspace: root,
          dataDir: join(root, "state"),
          model: "scripted",
          policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
        }, {
          mainModel: new ScriptedModel([]),
          createRunId: () => `interactive-command-arguments-${columns}`,
        });
        const running = runInteractive({ session, terminal, forceAltScreen: true });

        await terminal.started;
        terminal.type("/permissions fu");
        await waitForOutput(terminal, "Full Access");
        terminal.send("\r");
        terminal.send("\r");
        await waitForOutput(terminal, "Permissions set to full-access");
        expect(session.snapshot().permissionProfile).toBe("full-access");

        terminal.type("/mode pl");
        await waitForOutput(terminal, "Plan");
        terminal.send("\r");
        terminal.send("\r");
        await waitForOutput(terminal, "Plan mode selected");
        expect(session.snapshot().collaborationMode).toBe("plan");

        terminal.type("/goal Keep the first line");
        terminal.send("\n");
        terminal.type("and preserve the second line");
        terminal.send("\r");
        await waitForCondition(
          () => session.snapshot().goal?.objective === "Keep the first line\nand preserve the second line",
          "multiline Goal revision",
        );

        // Completing an argument and submitting a multiline command must leave
        // the editor focused for the next command on both narrow and wide TUIs.
        terminal.type("/status");
        terminal.send("\r");
        await waitForOutput(terminal, "Queue / Tokens");

        terminal.type("/exit");
        terminal.send("\r");
        await expect(running).resolves.toBe(0);
      } finally {
        process.exitCode = previousExitCode;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("shows the exact workspace Bash failure in status and permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-sandbox-diagnostic-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        allowWrite: true,
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        workspaceCommandSandbox: new WorkspaceCommandSandbox({ platform: "win32" }),
      });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "sandboxed Bash unavailable");
      expect(normalizeTerminalOutput(terminal.output))
        .toContain("no OS sandbox backend for win32");

      const permissionsOutputStart = terminal.output.length;
      terminal.type("/permissions");
      terminal.send("\r");
      await waitForCondition(
        () => normalizeTerminalOutput(terminal.output.slice(permissionsOutputStart))
          .includes("no OS sandbox backend for win32"),
        "workspace Bash diagnostic in permission selector",
      );
      const permissionsOutput = normalizeTerminalOutput(
        terminal.output.slice(permissionsOutputStart),
      );
      expect(permissionsOutput).toContain("sandboxed Bash unavailable");
      expect(permissionsOutput).toContain("no OS sandbox backend for win32");

      terminal.send("\x1b");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes ! and !! through the permission boundary with distinct context semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-bash-prefixes-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    const model = new ScriptedModel([
      (request) => {
        const messages = request.messages
          .map((message) => typeof message.content === "string" ? message.content : "")
          .join("\n");
        expect(messages).toContain("ran:printf hello");
        return response("first");
      },
      (request) => {
        const messages = request.messages
          .map((message) => typeof message.content === "string" ? message.content : "")
          .join("\n");
        expect(messages).not.toContain("ran:printf hidden");
        return response("second");
      },
    ]);
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        allowWrite: true,
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        workspaceCommandSandbox: new WorkspaceCommandSandbox({
          platform: "darwin",
          seatbeltExecutable: "/usr/bin/true",
          probe: () => true,
          execute: async ({ command }) => shellExecution(`ran:${command}`),
        }),
      });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("!printf hello");
      terminal.send("\r");
      await waitForOutput(terminal, "Bash output queued for the next prompt");

      terminal.type("Explain the output");
      terminal.send("\r");
      await waitForModelCalls(model, 1);

      terminal.type("!!printf hidden");
      terminal.send("\r");
      await waitForOutput(terminal, "context disabled");
      terminal.type("Continue");
      terminal.send("\r");
      await waitForModelCalls(model, 2);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("asks for a wider permission boundary after a Bash denial and retries once", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-permission-approval-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    let attempts = 0;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        allowWrite: true,
        allowShell: false,
        allowNetwork: false,
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        workspaceCommandSandbox: new WorkspaceCommandSandbox({
          platform: "darwin",
          seatbeltExecutable: "/usr/bin/true",
          probe: () => true,
          execute: async () => {
            attempts += 1;
            if (attempts === 1) {
              const denied = shellExecution("");
              return {
                ...denied,
                exitCode: null,
                spawnError: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
              };
            }
            return shellExecution("approved");
          },
        }),
      });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("!printf approved");
      terminal.send("\r");
      await waitForOutput(terminal, "Permission required");
      expect(attempts).toBe(1);
      terminal.send("\r");
      await waitForOutput(terminal, "Bash output queued for the next prompt");
      // The first attempt uses the injected workspace sandbox. Approval
      // promotes the session, so the retry uses the host executor instead.
      expect(attempts).toBe(1);
      expect(session.snapshot().permissionProfile).toBe("full-access");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
      await session.close();
      await delay(25);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Prime-style focused selectors to switch Main and restores editor focus", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-selectors-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted-main",
        tetoModel: "scripted-teto",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([response("PLAN_ANSWER")]) });
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        modelChoices: ["openrouter:next-model"],
      });

      await terminal.started;
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Models");
      expect(session.snapshot().model).toBe("scripted-main");

      terminal.type("next");
      await waitForOutput(terminal, "openrouter:next-model");
      terminal.send("\r");
      await waitForOutput(terminal, "Main model set to openrouter:next-model");
      expect(session.snapshot().model).toBe("openrouter:next-model");

      terminal.type("/model openrouter:direct-model");
      terminal.send("\r");
      await waitForOutput(terminal, "Main model set to openrouter:direct-model");
      expect(session.snapshot().model).toBe("openrouter:direct-model");

      terminal.type("/theme");
      terminal.send("\r");
      await waitForOutput(terminal, "Preview with Up/Down");
      terminal.send("\x1b[B");
      terminal.send("\r");
      await waitForOutput(terminal, "Theme set to light");

      terminal.type("/theme");
      terminal.send("\r");
      await waitForOutput(terminal, "Esc to restore");
      terminal.send("\x1b[B");
      terminal.send("\x1b");

      // Cancel must restore editor focus; this command would otherwise be
      // consumed as selector search text.
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");

      terminal.type("/permissions");
      terminal.send("\r");
      await waitForOutput(terminal, "Choose the capability boundary");
      terminal.send("\x1b[B");
      terminal.send("\r");
      await waitForOutput(terminal, "Permissions set to workspace");
      expect(session.snapshot()).toMatchObject({
        permissionProfile: "workspace",
        allowWrite: true,
        allowShell: false,
        allowNetwork: false,
      });

      terminal.type("/plan Propose a focused migration");
      terminal.send("\r");
      await waitForOutput(terminal, "PLAN_ANSWER");
      expect(session.snapshot().collaborationMode).toBe("plan");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets first-run setup skip safely and retry model selection without exposing the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-onboarding-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    const sentinelKey = "or-onboarding-secret-9876";
    const catalog: readonly ModelCatalogEntry[] = [{
      selector: "openrouter:demo",
      provider: "openrouter",
      id: "demo",
      name: "Demo",
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_096,
      imageInput: false,
      toolUse: "unknown",
      reasoning: false,
      authStatus: "unverified",
    }];
    try {
      const model = new ScriptedModel([response("ONBOARDING_ANSWER")]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: UNCONFIGURED_MODEL,
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        modelCatalog: catalog,
        createRunId: () => "onboarding-run",
      });
      const environment = { OPENROUTER_API_KEY: sentinelKey };
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        startupModelMissing: true,
        startupNotice: () => startupGuidance({
          model: session.model === UNCONFIGURED_MODEL ? undefined : session.model,
          catalog,
          environment,
        }),
        credentialStatus: () => inspectCredential(
          session.model === UNCONFIGURED_MODEL ? undefined : session.model,
          catalog,
          environment,
        ),
        modelChoices: catalog.map((entry) => entry.selector),
        initialMessage: "held startup task",
      });

      await terminal.started;
      await waitForOutput(terminal, "Local setup");
      await waitForOutput(terminal, "Models");
      await waitForOutput(terminal, "Initial task is kept in the editor");
      expect(terminal.output).toContain("****9876");
      expect(terminal.output).not.toContain(sentinelKey);

      terminal.send("\x1b");
      terminal.send("\r");
      await waitForOutput(terminal, "Choose a model with /model");
      expect(model.callCount).toBe(0);
      expect(session.snapshot().runId).toBeUndefined();

      terminal.send("\x03");
      terminal.type("/model openrouter:demo");
      terminal.send("\r");
      await waitForOutput(terminal, "Main model set to openrouter:demo");
      terminal.type("run after setup");
      terminal.send("\r");
      await waitForOutput(terminal, "ONBOARDING_ANSWER");
      expect(model.callCount).toBe(1);

      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Auth:");
      const statusOutput = normalizeTerminalOutput(terminal.output);
      expect(statusOutput).toContain("OPENROUTER_API_KEY");
      expect(statusOutput).toContain("****9876");
      expect(statusOutput).not.toContain(sentinelKey);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the setup diagnostic available as a slash command", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-setup-command-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "openrouter:demo",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        createRunId: () => "setup-command-run",
      });
      const running = runInteractive({
        session,
        terminal,
        forceAltScreen: true,
        startupNotice: "CONFIGURED_SETUP_STATUS",
        showStartupSetup: false,
      });

      await terminal.started;
      await delay(120);
      expect(terminal.output).not.toContain("CONFIGURED_SETUP_STATUS");

      terminal.type("/setup");
      terminal.send("\r");
      await waitForOutput(terminal, "CONFIGURED_SETUP_STATUS");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears collapsed selector rows on the regular main screen", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-selector-main-screen-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: UNCONFIGURED_MODEL,
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        modelCatalog: [{
          selector: "openrouter:demo",
          provider: "openrouter",
          id: "demo",
          name: "Demo",
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
          imageInput: false,
          toolUse: "unknown",
          reasoning: false,
          authStatus: "unverified",
        }],
      });
      const running = runInteractive({
        session,
        terminal,
        startupModelMissing: true,
        startupNotice: "SETUP_MAIN_SCREEN",
        modelChoices: ["openrouter:demo"],
      });

      await terminal.started;
      await waitForOutput(terminal, "Models");
      const beforeCancel = terminal.output.length;
      terminal.send("\x03");
      await waitForCondition(
        () => terminal.output.length > beforeCancel && !terminal.output.slice(-200).includes("Models"),
        "selector cancellation render",
      );
      const cancelFrame = terminal.output.slice(beforeCancel);
      // pi-tui's clear-on-shrink path may use either differential line clears
      // or a synchronized full redraw when the viewport has scrolled.
      expect(cancelFrame.includes("\x1b[2K") || cancelFrame.includes("\x1b[2J")).toBe(true);
      expect(cancelFrame).not.toContain("\x1b[?1049h");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reserve established compatibility commands as unapproved", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-unapproved-commands-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "unapproved-command-run",
      });
      const events: SessionRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/unknown-command");
      terminal.send("\r");
      await waitForOutput(terminal, "Unknown command: /unknown-command");
      expect(model.callCount).toBe(0);
      expect(events.filter((event) => event.kind === "event")).toHaveLength(0);

      terminal.type("/quit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attaches and restores history when /resume receives a saved Run id", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-resume-history-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const saved = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("RESUME_HISTORY_ANSWER")]),
        createRunId: () => "resume-history-run",
      });
      await saved.submit({ inputId: "resume-history-input", text: "Remember this" });
      await saved.waitForIdle();
      await saved.close();

      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        createRunId: () => "resume-current-run",
      });
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/resume resume-history-run");
      terminal.send("\r");
      await waitForCondition(
        () => current.snapshot().runId === "resume-history-run",
        "Run attachment through /resume",
      );
      await waitForOutput(terminal, "Attached Run resume-history-run");
      await waitForOutput(terminal, "RESUME_HISTORY_ANSWER");
      await expect(current.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "Remember this" }),
        expect.objectContaining({ role: "assistant", content: "RESUME_HISTORY_ANSWER" }),
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forks the attached Run through /fork and switches to the child transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-fork-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("FORK_SOURCE_ANSWER")]),
        createRunId: () => "fork-source-run",
      });
      await session.submit({ inputId: "fork-source-input", text: "FORK_SOURCE_GOAL" });
      await session.waitForIdle();

      const running = runInteractive({ session, terminal, forceAltScreen: true });
      await terminal.started;
      terminal.type("/fork fork-child-run");
      terminal.send("\r");
      await waitForCondition(
        () => session.snapshot().runId === "fork-child-run",
        "child Run attachment through /fork",
      );
      await waitForOutput(terminal, "Forked Run fork-source-run to fork-child-run");
      await waitForOutput(terminal, "FORK_SOURCE_ANSWER");
      await expect(session.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "FORK_SOURCE_GOAL" }),
        expect.objectContaining({ role: "assistant", content: "FORK_SOURCE_ANSWER" }),
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("navigates the Run tree and forks from a selected historical checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-tree-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const source = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("TREE_SOURCE_ANSWER")]),
        createRunId: () => "tree-ui-parent",
      });
      await source.submit({ inputId: "tree-ui-input", text: "TREE_SOURCE_GOAL" });
      await source.waitForIdle();
      await source.close();
      const sourceSummary = (await listWorkspaceRuns(dataDir, root))
        .find((run) => run.runId === "tree-ui-parent");
      const checkpoint = sourceSummary?.checkpoints?.[0];
      if (checkpoint === undefined) throw new Error("Missing source checkpoint");

      const session = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/tree");
      terminal.send("\r");
      await waitForOutput(terminal, "Session tree");
      terminal.type(`checkpoint ${checkpoint.watermark}`);
      terminal.send("\r");
      await waitForCondition(
        () => session.snapshot().runId !== undefined
          && session.snapshot().runId !== "tree-ui-parent",
        "historical checkpoint fork through /tree",
      );
      await waitForOutput(terminal, `Forked Run tree-ui-parent at checkpoint ${checkpoint.watermark}`);
      const tree = await session.workspaceRunTree();
      expect(tree).toHaveLength(1);
      expect(tree[0]?.children).toHaveLength(1);
      expect(tree[0]?.children[0]?.run.parentCheckpoint).toEqual(checkpoint);
      expect(tree[0]?.children[0]?.run.branchSummary).toContain(
        `checkpoint ${checkpoint.watermark}`,
      );

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unavailable compaction through /compact without a Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-compact-"));
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 1, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/compact");
      terminal.send("\r");
      await waitForOutput(terminal, "Compaction is unavailable for this Run");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects durable compaction lifecycle events without duplicate command notices", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-compact-events-"));
    const previousExitCode = process.exitCode;
    try {
      let mainCalls = 0;
      const model: ModelPort = {
        capabilities: () => ({ imageInput: false, contextWindowTokens: 32_000 }),
        async complete(request) {
          if (request.sessionId.startsWith("fukai-compaction:")) {
            return response(JSON.stringify({
              decisions: ["Keep the completed answer as verified context"],
              verifiedResults: ["The Main Turn completed"],
              openQuestions: [],
            }));
          }
          mainCalls += 1;
          return response("x".repeat(5_000));
        },
      };
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        fukaiCompaction: {
          enabled: true,
          provider: "pi-ai",
          maxInputTokens: 12_000,
          maxOutputTokens: 500,
          maxWallClockMs: 5_000,
          retainRatio: 0.001,
          minimumGainTokens: 1,
        },
        policy: { maxMainStepsPerActivation: 1, maxModelTokens: 100_000, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-compact-events-run",
      });
      const terminal = new MemoryTerminal(100, 28);
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("Build a durable summary");
      terminal.send("\r");
      await waitForCondition(() => mainCalls >= 1, "Main compaction fixture response");
      await session.waitForIdle();
      terminal.type("/compact");
      terminal.send("\r");
      await waitForOutput(terminal, "Compacting context...");
      await waitForOutput(terminal, "Context compacted for the next Turn.");
      expect(countOccurrences(terminal.output, "Context compacted for the next Turn.")).toBe(1);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens the Run picker without requesting the model when /resume is entered", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-resume-latest-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const saved = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("LATEST_RESUME_ANSWER")]),
        createRunId: () => "latest-resume-run",
      });
      await saved.submit({ inputId: "latest-resume-input", text: "Latest history" });
      await saved.waitForIdle();
      await saved.close();

      const currentModel = new ScriptedModel([]);
      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: currentModel,
        createRunId: () => "detached-resume-run",
      });
      await current.newRun();
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/resume");
      terminal.send("\r");
      await waitForOutput(terminal, "Resume a previous session");
      expect(normalizeTerminalOutput(terminal.output)).toContain("Run ID latest-resume-run");
      terminal.type("latest-resume-run");
      terminal.send("\r");
      await waitForCondition(
        () => current.snapshot().runId === "latest-resume-run",
        "selected Run attachment through /resume",
      );
      await waitForOutput(terminal, "Attached Run latest-resume-run");
      expect(currentModel.callCount).toBe(0);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switches saved workspace Runs through the resume selector and reloads transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-sessions-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const older = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("OLDER_TRANSCRIPT_ANSWER")]),
        createRunId: () => "older-session-run",
      });
      await older.submit({ inputId: "older-input", text: "OLDER_SESSION_GOAL" });
      await older.waitForIdle();
      await older.close();

      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("CURRENT_TRANSCRIPT_ANSWER")]),
        createRunId: () => "current-session-run",
      });
      await current.submit({ inputId: "current-input", text: "CURRENT_SESSION_GOAL" });
      await current.waitForIdle();
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/resume");
      terminal.send("\r");
      await waitForOutput(terminal, "Resume a previous session");
      terminal.send("\x1b");
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");
      expect(current.snapshot().runId).toBe("current-session-run");

      const selectorCount = countOccurrences(
        terminal.output,
        "Resume a previous session",
      );
      terminal.type("/resume");
      terminal.send("\r");
      await waitForCondition(
        () => countOccurrences(
          terminal.output,
          "Resume a previous session",
        ) > selectorCount,
        "second resume selector",
      );
      terminal.type("older-session-run");
      await waitForOutput(terminal, "OLDER_SESSION_GOAL");
      const beforeSwitch = terminal.output.length;
      terminal.send("\r");
      await waitForCondition(
        () => current.snapshot().runId === "older-session-run",
        "selected Run attachment",
      );
      await waitForOutput(terminal, "Attached Run older-session-run");
      await waitForOutput(terminal, "OLDER_TRANSCRIPT_ANSWER");
      const olderFrame = terminal.output.slice(beforeSwitch);
      expect(olderFrame).toContain("OLDER_TRANSCRIPT_ANSWER");
      expect(olderFrame.lastIndexOf("OLDER_TRANSCRIPT_ANSWER"))
        .toBeGreaterThan(olderFrame.lastIndexOf("CURRENT_TRANSCRIPT_ANSWER"));
      await expect(current.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "OLDER_SESSION_GOAL" }),
        expect.objectContaining({ role: "assistant", content: "OLDER_TRANSCRIPT_ANSWER" }),
      ]);

      terminal.type("/resume current-session-run");
      terminal.send("\r");
      await waitForCondition(
        () => current.snapshot().runId === "current-session-run",
        "direct Run attachment",
      );
      await waitForOutput(terminal, "Attached Run current-session-run");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discards a slow previous hydration after a newer Run has attached", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-hydration-race-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let current: SessionController | undefined;
    let running: Promise<number> | undefined;
    try {
      for (const runId of ["slow-hydration-run", "latest-hydration-run"]) {
        const seed = await SessionController.open({
          workspace: root, dataDir, model: "scripted", policy: { tetoEnabled: false },
        }, { mainModel: new ScriptedModel([response(`${runId}_ANSWER`)]), createRunId: () => runId });
        try {
          await seed.submit({ inputId: `${runId}-input`, text: `Question for ${runId}` });
          await seed.waitForIdle();
        } finally {
          await seed.close();
        }
      }
      current = await SessionController.open({
        workspace: root, dataDir, model: "scripted", policy: { tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]), createRunId: () => "initial-hydration-run" });
      await current.newRun();
      const originalTranscript = current.transcript.bind(current);
      let hydrating = false;
      current.transcript = async () => {
        const runId = current!.snapshot().runId;
        const entries = await originalTranscript();
        if (runId === "slow-hydration-run") {
          hydrating = true;
          await gate;
          hydrating = false;
        }
        return entries;
      };
      running = runInteractive({ session: current, terminal, forceAltScreen: true });
      await terminal.started;
      terminal.type("/resume");
      terminal.send("\r");
      await waitForOutput(terminal, "Resume a previous session");
      terminal.type("slow-hydration-run");
      terminal.send("\r");
      await waitForCondition(() => hydrating, "slow history hydration");
      terminal.type("/resume latest-hydration-run");
      terminal.send("\r");
      await waitForOutput(terminal, "Attached Run latest-hydration-run");
      const beforeRelease = terminal.output.length;
      release();
      await waitForCondition(() => !hydrating, "old history read returning");
      terminal.type("/status");
      terminal.send("\r");
      await waitForCondition(() => terminal.output.slice(beforeRelease).includes("Queue / Tokens"), "post-switch frame");
      expect(current.snapshot().runId).toBe("latest-hydration-run");
      expect(terminal.output.slice(beforeRelease)).not.toContain("slow-hydration-run_ANSWER");
      expect(terminal.output.slice(beforeRelease)).not.toContain("Attached Run slow-hydration-run");
    } finally {
      release();
      if (running !== undefined) {
        terminal.type("/exit");
        terminal.send("\r");
        await running;
      } else {
        await current?.close();
      }
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resume another Run when an explicit current-Run resume races a picker attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-resume-target-race-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(120, 32);
    const previousExitCode = process.exitCode;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let current: SessionController | undefined;
    let running: Promise<number> | undefined;
    try {
      for (const [runId, reason] of [["race-current-run", "stop"], ["race-target-run", "length"]] as const) {
        const seed = await SessionController.open({
          workspace: root, dataDir, model: "scripted", policy: { tetoEnabled: false },
        }, { mainModel: new ScriptedModel([response(`${runId}_ANSWER`, [], reason)]), createRunId: () => runId });
        try {
          await seed.submit({ inputId: `${runId}-input`, text: `Question for ${runId}` });
          await seed.waitForIdle();
        } finally {
          await seed.close();
        }
      }
      const model = new ScriptedModel([response("UNEXPECTED_TARGET_RESUME")]);
      current = await SessionController.open({
        workspace: root, dataDir, model: "scripted", runId: "race-current-run",
      }, { mainModel: model });
      const resumedRuns: string[] = [];
      current.subscribe((event) => {
        if (event.kind === "event" && event.event.type === "turn.resumed") resumedRuns.push(event.event.runId);
      });
      const attachment = current as unknown as { openAttachment(runId: string): Promise<unknown> };
      const openAttachment = attachment.openAttachment.bind(current);
      let attachmentEntered = false;
      attachment.openAttachment = async (runId) => {
        if (runId === "race-target-run") {
          attachmentEntered = true;
          await gate;
        }
        return openAttachment(runId);
      };
      running = runInteractive({ session: current, terminal, forceAltScreen: true });
      await terminal.started;
      terminal.type("/resume");
      terminal.send("\r");
      await waitForOutput(terminal, "Resume a previous session");
      terminal.type("race-target-run");
      terminal.send("\r");
      await waitForCondition(() => attachmentEntered, "picker attachment inside admission");
      expect(current.snapshot().runId).toBe("race-current-run");

      terminal.type("/resume race-current-run");
      terminal.send("\r");
      await delay(30);
      release();
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");
      await current.waitForIdle();
      expect(resumedRuns).not.toContain("race-target-run");
      expect(model.callCount).toBe(0);
    } finally {
      release();
      if (running !== undefined) {
        terminal.type("/exit");
        terminal.send("\r");
        await running;
      } else {
        await current?.close();
      }
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps current history after a rejected fork supersedes a slow hydration", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-rejected-fork-hydration-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(120, 32);
    const previousExitCode = process.exitCode;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let current: SessionController | undefined;
    let running: Promise<number> | undefined;
    try {
      const seed = await SessionController.open({
        workspace: root, dataDir, model: "scripted", policy: { tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("REJECTED_FORK_HISTORY_ANSWER")]),
        createRunId: () => "fork-hydration-run",
      });
      try {
        await seed.submit({ inputId: "fork-history-input", text: "History for the attached Run" });
        await seed.waitForIdle();
      } finally {
        await seed.close();
      }
      current = await SessionController.open({
        workspace: root, dataDir, model: "scripted", policy: { tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const originalTranscript = current.transcript.bind(current);
      let historyHeld = false;
      let hydrating = false;
      current.transcript = async () => {
        const entries = await originalTranscript();
        if (!historyHeld && current!.snapshot().runId === "fork-hydration-run") {
          historyHeld = true;
          hydrating = true;
          await gate;
          hydrating = false;
        }
        return entries;
      };
      const originalFork = current.forkRun.bind(current);
      let forkRejected = false;
      current.forkRun = async (options) => {
        try {
          return await originalFork(options);
        } catch (error: unknown) {
          forkRejected = true;
          throw error;
        }
      };
      running = runInteractive({ session: current, terminal, forceAltScreen: true });
      await terminal.started;
      terminal.type("/resume");
      terminal.send("\r");
      await waitForOutput(terminal, "Resume a previous session");
      terminal.type("fork-hydration-run");
      terminal.send("\r");
      await waitForCondition(() => hydrating, "current history hydration");

      terminal.type("/fork fork-hydration-run");
      terminal.send("\r");
      await waitForCondition(() => forkRejected, "self-fork rejection");
      release();
      await waitForCondition(() => !hydrating, "current history read returning");
      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");
      expect(current.snapshot().runId).toBe("fork-hydration-run");
      expect(normalizeTerminalOutput(terminal.output)).toContain("REJECTED_FORK_HISTORY_ANSWER");
    } finally {
      release();
      if (running !== undefined) {
        terminal.type("/exit");
        terminal.send("\r");
        await running;
      } else {
        await current?.close();
      }
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears the previous transcript when an attached Run cannot hydrate its artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-session-artifact-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const damaged = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("DAMAGED_TRANSCRIPT_ANSWER")]),
        createRunId: () => "damaged-artifact-run",
      });
      await damaged.submit({ inputId: "damaged-input", text: "DAMAGED_ARTIFACT_GOAL" });
      await damaged.waitForIdle();
      await damaged.close();
      await rm(join(dataDir, "runs", "damaged-artifact-run", "store"), {
        recursive: true,
        force: true,
      });

      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("CURRENT_ARTIFACT_ANSWER")]),
        createRunId: () => "current-artifact-run",
      });
      await current.submit({ inputId: "current-input", text: "CURRENT_ARTIFACT_GOAL" });
      await current.waitForIdle();
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });

      await terminal.started;
      await waitForOutput(terminal, "CURRENT_ARTIFACT_ANSWER");
      const attachRun = current.attachRun.bind(current);
      let releaseAttachment!: () => void;
      let attachmentEntered = false;
      const attachmentGate = new Promise<void>((resolve) => { releaseAttachment = resolve; });
      current.attachRun = async (runId) => {
        attachmentEntered = true;
        await attachmentGate;
        return attachRun(runId);
      };
      terminal.type("/resume damaged-artifact-run");
      const chunkCountBeforeSwitch = terminal.outputChunks.length;
      terminal.send("\r");
      try {
        await waitForCondition(() => attachmentEntered, "attachment admission");
        await delay(40);
        const whileAttaching = terminal.outputChunks.slice(chunkCountBeforeSwitch).join("");
        expect(whileAttaching).not.toContain("CURRENT_ARTIFACT_GOAL");
        expect(whileAttaching).not.toContain("CURRENT_ARTIFACT_ANSWER");
      } finally {
        releaseAttachment();
      }
      await waitForCondition(
        () => current.snapshot().runId === "damaged-artifact-run",
        "damaged Run attachment",
      );
      await waitForOutput(terminal, "was not found");
      const transition = terminal.outputChunks.slice(chunkCountBeforeSwitch).join("");
      expect(transition).toContain("was not found");
      expect(transition).not.toContain("CURRENT_ARTIFACT_GOAL");
      expect(transition).not.toContain("CURRENT_ARTIFACT_ANSWER");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the previous transcript when Run attachment is rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-session-rejected-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    let running: Promise<number> | undefined;
    let session: SessionController | undefined;
    try {
      session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("RESTORED_TRANSCRIPT_ANSWER")]),
        createRunId: () => "original-attachment-run",
      });
      await session.submit({ inputId: "original-input", text: "RESTORED_TRANSCRIPT_GOAL" });
      await session.waitForIdle();
      running = runInteractive({ session, terminal, forceAltScreen: true });
      await terminal.started;
      await waitForOutput(terminal, "RESTORED_TRANSCRIPT_ANSWER");

      terminal.type("/resume nonexistent-attachment-run");
      const outputBeforeSwitch = terminal.output.length;
      terminal.send("\r");
      await waitForOutput(terminal, "is missing creation facts");
      expect(session.snapshot().runId).toBe("original-attachment-run");
      const transition = terminal.output.slice(outputBeforeSwitch);
      expect(transition).toContain("RESTORED_TRANSCRIPT_GOAL");
      expect(transition).toContain("RESTORED_TRANSCRIPT_ANSWER");
      await expect(session.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "RESTORED_TRANSCRIPT_GOAL" }),
        expect.objectContaining({ role: "assistant", content: "RESTORED_TRANSCRIPT_ANSWER" }),
      ]);
    } finally {
      terminal.type("/exit");
      terminal.send("\r");
      await running;
      await session?.close();
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses session switching while Main has an active Turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-session-active-"));
    const dataDir = join(root, "state");
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    let releaseCurrent = (_response: ModelResponse): void => {};
    try {
      const saved = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([]),
        createRunId: () => "saved-session-run",
      });
      await saved.reviseGoal("Saved Run");
      await saved.close();

      const responseGate = new Promise<ModelResponse>((resolve) => { releaseCurrent = resolve; });
      const current = await SessionController.open({
        workspace: root,
        dataDir,
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([async () => responseGate]),
        createRunId: () => "active-session-run",
      });
      const running = runInteractive({ session: current, terminal, forceAltScreen: true });
      await terminal.started;
      terminal.type("Keep working");
      terminal.send("\r");
      await waitForCondition(() => current.snapshot().status === "running", "active Turn");

      terminal.type("/resume saved-session-run");
      terminal.send("\r");
      await waitForOutput(terminal, "/resume is unavailable while Main is working");
      expect(current.snapshot().runId).toBe("active-session-run");
      terminal.type("/resume");
      terminal.send("\r");
      await waitForCondition(
        () => countOccurrences(
          terminal.output,
          "/resume is unavailable while Main is working",
        ) >= 2,
        "selector rejection during active Turn",
      );
      expect(current.snapshot().runId).toBe("active-session-run");

      releaseCurrent(response("ACTIVE_SESSION_ANSWER"));
      await current.waitForIdle();
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseCurrent(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back an unconfirmed theme preview during SIGTERM shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-selector-signal-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    const previousScheme = getNausicaaColorScheme();
    setNausicaaColorScheme("light");
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/theme");
      terminal.send("\r");
      await waitForOutput(terminal, "Preview with Up/Down");
      terminal.send("\x1b[B");
      terminal.send("\x1b[B");
      await waitForCondition(
        () => getNausicaaColorScheme() === "dark",
        "dark theme preview",
      );

      process.emit("SIGTERM", "SIGTERM");
      await expect(running).resolves.toBe(0);
      expect(getNausicaaColorScheme()).toBe("light");
    } finally {
      process.exitCode = previousExitCode;
      setNausicaaColorScheme(previousScheme);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an external SIGINT as selector cancel before allowing exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-selector-sigint-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, { mainModel: new ScriptedModel([]) });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("/model");
      terminal.send("\r");
      await waitForOutput(terminal, "Models");
      process.emit("SIGINT", "SIGINT");
      await delay(20);
      expect(session.snapshot().status).not.toBe("closed");

      terminal.type("/status");
      terminal.send("\r");
      await waitForOutput(terminal, "Queue / Tokens");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a tool lifecycle and replaces partial deltas with the committed answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-tool-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 4, tetoEnabled: false },
      }, {
        mainModel: new PartialToolModel(),
        tools: [inspectTool],
        createRunId: () => "interactive-tool-run",
      });
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("inspect the manifest");
      terminal.send("\r");
      await completed;
      await waitForOutput(terminal, "FINAL_COMMITTED_SENTINEL");

      expect(terminal.output).toContain("inspect_manifest");
      expect(terminal.output).toContain("package.json");
      expect(terminal.output).not.toContain("TOOL_RESULT_COMMITTED");

      terminal.send("\x0f");
      await waitForOutput(terminal, "TOOL_RESULT_COMMITTED");
      expect(terminal.output).toContain("arguments");
      expect(terminal.output).toContain("package.json");
      expect(terminal.output).toContain("result");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
      expect(terminal.output).toContain("\x1b[?1049l");
      expect(exitFrame(terminal.output)).toContain("Nausicaa");
      expect(exitFrame(terminal.output)).not.toContain("▄██▀");
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders an unresolved tool from the attached transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-unknown-tool-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const initial = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("done")]),
        createRunId: () => "interactive-unknown-tool-run",
      });
      await initial.submit({ inputId: "initial-input", text: "prepare" });
      await initial.waitForIdle();
      const runId = initial.snapshot().runId!;
      await initial.close();

      const store = await FileContentAddressedStore.open(
        join(root, "state", "runs", runId, "store"),
      );
      const argumentsRef = await store.put(
        JSON.stringify({ path: "src/config.ts", content: "replacement" }),
        "application/vnd.nausicaa.tool-arguments+json",
      );
      const ledger = await JsonlLedger.open(
        join(root, "state", "runs", runId, "ledger.jsonl"),
      );
      const events = await ledger.read({ runId });
      const turnId = events.find((event) => event.type === "turn.started")?.payload.turnId;
      if (turnId === undefined) throw new Error("missing test Turn");
      await ledger.append({
        runId,
        turnId,
        laneId: "main",
        type: "tool.requested",
        payload: {
          operationId: "unknown-op",
          toolCallId: "unknown-call",
          name: "write_file",
          argumentsRef,
        },
        correlationId: `turn:${turnId}`,
        idempotencyKey: "test:unknown-request",
        visibility: "run",
      });
      await ledger.append({
        runId,
        turnId,
        laneId: "main",
        type: "tool.unknown",
        payload: {
          operationId: "unknown-op",
          toolCallId: "unknown-call",
          name: "write_file",
          reason: "provider response was lost",
        },
        correlationId: `turn:${turnId}`,
        idempotencyKey: "test:unknown-outcome",
        visibility: "run",
      });
      await ledger.close();

      const resumed = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId,
      });
      const running = runInteractive({ session: resumed, terminal, forceAltScreen: true });
      await terminal.started;
      await waitForOutput(terminal, "unknown-op");

      expect(terminal.output).toContain("write_file");
      expect(terminal.output).toContain("unknown");
      expect(terminal.output).toContain("src/config.ts");
      expect(terminal.output).toContain("replacement");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reprojects a durable queued input after reopening the Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-queue-reopen-"));
    const runId = "interactive-durable-queue-reopen-run";
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const initial = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new ScriptedModel([response("INITIAL_QUEUE_REOPEN_ANSWER")]),
        createRunId: () => runId,
      });
      await initial.submit({ inputId: "initial-input", text: "prepare" });
      await initial.waitForIdle();
      expect(initial.snapshot().runId).toBe(runId);
      await initial.close();

      const store = await FileContentAddressedStore.open(
        join(root, "state", "runs", runId, "store"),
      );
      const messageRef = await store.put(JSON.stringify({
        role: "user",
        content: "DURABLE_QUEUE_SENTINEL",
        createdAt: new Date().toISOString(),
      }), MESSAGE_MEDIA_TYPE);
      const ledger = await JsonlLedger.open(
        join(root, "state", "runs", runId, "ledger.jsonl"),
      );
      const events = await ledger.read({ runId });
      const nextSequence = events.reduce((highest, event) => (
        event.type === "input.admitted"
          ? Math.max(highest, event.payload.sequence)
          : highest
      ), 0) + 1;
      await ledger.append({
        runId,
        laneId: "main",
        type: "input.admitted",
        payload: {
          inputId: "reopened-follow-up",
          messageRef,
          delivery: "follow-up",
          sequence: nextSequence,
        },
        correlationId: "input:reopened-follow-up",
        idempotencyKey: `${runId}:input:reopened-follow-up:admitted`,
        visibility: "user",
      });
      await ledger.close();

      const resumed = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        runId,
      }, {
        mainModel: new ScriptedModel([]),
      });
      const running = runInteractive({ session: resumed, terminal, forceAltScreen: true });

      await terminal.started;
      await waitForOutput(terminal, "DURABLE_QUEUE_SENTINEL");
      const visible = normalizeTerminalOutput(terminal.output);
      expect(visible).toContain("follow-up");
      expect(await resumed.pendingInputs()).toEqual([
        expect.objectContaining({
          inputId: "reopened-follow-up",
          delivery: "follow-up",
          text: "DURABLE_QUEUE_SENTINEL",
        }),
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates the durable Worker summary from running through ready and done", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-worker-summary-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    let releaseWorker = (_response: ModelResponse): void => {};
    let releaseMain = (_response: ModelResponse): void => {};
    let markWorkerStarted = (): void => {};
    let markMainWaiting = (): void => {};
    const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
    const mainWaiting = new Promise<void>((resolve) => { markMainWaiting = resolve; });
    try {
      const workerModel = new ScriptedModel([async () => {
        markWorkerStarted();
        return new Promise<ModelResponse>((resolve) => { releaseWorker = resolve; });
      }]);
      const mainModel = new ScriptedModel([
        response("Delegating", [{
          id: "delegate-summary",
          name: "delegate_task",
          arguments: {
            taskId: "summary-task",
            statement: "Inspect the package name",
            successCriteria: ["Return the package name"],
            maxModelTokens: 200,
            maxWallClockMs: 5_000,
          },
        }], "toolUse"),
        async () => {
          markMainWaiting();
          return new Promise<ModelResponse>((resolve) => { releaseMain = resolve; });
        },
        response("WORKER_SUMMARY_DONE"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted/main",
        workerModel: "scripted/worker",
        workerEnabled: true,
        policy: {
          maxMainStepsPerActivation: 4,
          maxModelTokens: 10_000,
          tetoEnabled: false,
        },
      }, {
        mainModel,
        workerModel,
        tools: [inspectTool],
        createRunId: () => "interactive-worker-summary-run",
      });
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      terminal.type("inspect in parallel");
      terminal.send("\r");
      await Promise.all([workerStarted, mainWaiting]);
      await waitForOutput(terminal, "1 Worker task · 1 running");

      releaseWorker(response("package name: nausicaa"));
      await delay(100);
      await waitForOutput(terminal, "1 Worker task · 1 ready");

      releaseMain(response("Commit the Worker result", [{
        id: "worker-boundary",
        name: "inspect_manifest",
        arguments: { path: "package.json" },
      }], "toolUse"));
      await waitForOutput(terminal, "WORKER_SUMMARY_DONE");
      await waitForOutput(terminal, "1 Worker task · 1 done");

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      releaseWorker(response("cleanup"));
      releaseMain(response("cleanup"));
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows one durable failure notice and does not persist a streamed fragment", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-failure-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: new FailingStreamModel(),
        createRunId: () => "interactive-failure-run",
      });
      const failed = waitForDurableEvent(session, "turn.failed");
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("fail after starting");
      terminal.send("\r");
      await failed;
      await waitForOutput(terminal, "Turn failed.");

      expect(countOccurrences(terminal.output, "Turn failed.")).toBe(1);
      await expect(session.transcript()).resolves.toEqual([
        expect.objectContaining({ role: "user", content: "fail after starting" }),
      ]);

      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a length-limited answer and explains how to continue it", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-tui-output-limit-"));
    const terminal = new MemoryTerminal(100, 28);
    const previousExitCode = process.exitCode;
    try {
      const model = new ScriptedModel([
        response("PARTIAL_OUTPUT_SENTINEL", [], "length"),
        response("CONTINUED_OUTPUT_SENTINEL"),
      ]);
      const session = await SessionController.open({
        workspace: root,
        dataDir: join(root, "state"),
        model: "scripted",
        policy: { maxMainStepsPerActivation: 2, tetoEnabled: false },
      }, {
        mainModel: model,
        createRunId: () => "interactive-output-limit-run",
      });
      const originalSubmit = session.submit.bind(session);
      let releaseSubmit = (): void => {};
      const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
      session.submit = async (request) => {
        const result = await originalSubmit(request);
        await submitGate;
        return result;
      };
      const waiting = waitForDurableEvent(session, "turn.waiting");
      const completed = waitForDurableEvent(session, "turn.completed");
      const running = runInteractive({ session, terminal, forceAltScreen: true });

      await terminal.started;
      await delay(120);
      terminal.type("write a long answer");
      terminal.send("\r");
      await waiting;
      await waitForOutput(terminal, "The model reached its output limit");

      expect(terminal.output).toContain("PARTIAL_OUTPUT_SENTINEL");
      expect(session.snapshot().blocker).toBe("model-output-limit");
      terminal.type("/resume interactive-output-limit-run");
      terminal.send("\r");
      releaseSubmit();
      await waitForOutput(terminal, "CONTINUED_OUTPUT_SENTINEL");
      await completed;

      expect(model.requests[1]?.messages.at(-1)?.content)
        .toContain("Continue exactly where it stopped");
      terminal.type("/exit");
      terminal.send("\r");
      await expect(running).resolves.toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withAuthTui(
  options: {
    model?: string;
    refreshModels?: InteractiveAuthOptions["refreshModels"];
    modelChoices?: InteractiveOptions["modelChoices"];
    environment?: NodeJS.ProcessEnv;
    checkAuth?: AuthModelPort["checkAuth"];
  },
  check: (fixture: {
    terminal: MemoryTerminal;
    session: SessionController;
    credentialStore: FileCredentialStore;
    mainModel: ScriptedModel;
    modelPort: ReturnType<typeof createBuiltinModelPort>;
    running: Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nausicaa-multi-provider-tui-"));
  const previousExitCode = process.exitCode;
  let running: Promise<number> | undefined;
  let stopped = false;
  let session: SessionController | undefined;
  try {
    const credentialStore = new FileCredentialStore({ filePath: join(root, "credentials.json") });
    const modelPort = createBuiltinModelPort({
      credentials: credentialStore,
      authContext: { env: async (name) => options.environment?.[name], fileExists: async () => false },
    });
    if (options.checkAuth !== undefined) modelPort.checkAuth = options.checkAuth;
    const mainModel = new ScriptedModel([]);
    session = await SessionController.open({
      workspace: root,
      dataDir: join(root, "state"),
      model: options.model ?? UNCONFIGURED_MODEL,
      policy: { tetoEnabled: false },
    }, { mainModel });
    const terminal = new MemoryTerminal(100, 28);
    running = runInteractive({
      session,
      terminal,
      forceAltScreen: true,
      modelChoices: options.modelChoices ?? [
        { value: "anthropic:openai-lookalike", label: "Other model mentioning openai" },
        { value: "openai:test-model", label: "OpenAI model" },
      ],
      auth: {
        credentialStore,
        modelPort,
        environment: options.environment ?? {},
        ...(options.refreshModels === undefined ? {} : { refreshModels: options.refreshModels }),
      },
    }).finally(() => { stopped = true; });
    await terminal.started;
    await check({ terminal, session, credentialStore, mainModel, modelPort, running });
  } finally {
    if (running !== undefined && !stopped) process.emit("SIGTERM", "SIGTERM");
    try { await running; }
    finally {
      await session?.close();
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  }
}

class MemoryTerminal implements Terminal {
  readonly outputChunks: string[] = [];
  cursorVisible = true;
  kittyProtocolActive = false;
  private input?: (data: string) => void;
  private resolveStarted?: () => void;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });

  constructor(readonly columns: number, readonly rows: number) {}

  get output(): string { return this.outputChunks.join(""); }

  start(onInput: (data: string) => void): void {
    this.input = onInput;
    this.resolveStarted?.();
  }

  send(data: string): void { this.input?.(data); }
  type(value: string): void {
    for (const character of value) this.send(character);
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.outputChunks.push(data); }
  moveBy(): void {}
  hideCursor(): void { this.cursorVisible = false; }
  showCursor(): void { this.cursorVisible = true; }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

class PartialToolModel implements ModelPort {
  private call = 0;

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("stream() should be used by the interactive runtime");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.call += 1;
    yield { type: "start" };
    if (this.call === 1) {
      yield { type: "thinking-start" };
      yield { type: "thinking-delta", delta: "Inspect the smallest useful source first." };
      yield { type: "thinking-end" };
      yield { type: "text-delta", delta: "Inspecting" };
      yield {
        type: "done",
        response: response("Inspecting the manifest.", [{
          id: "inspect-1",
          name: "inspect_manifest",
          arguments: { path: "package.json" },
        }], "toolUse"),
      };
      return;
    }
    yield { type: "text-delta", delta: "FINAL_PART" };
    yield { type: "done", response: response("FINAL_COMMITTED_SENTINEL") };
  }
}

class TextOnlyScriptedModel extends ScriptedModel {
  capabilities(): { imageInput: boolean } {
    return { imageInput: false };
  }
}

class FailingStreamModel implements ModelPort {
  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("stream() should be used by the interactive runtime");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "start" };
    yield { type: "text-delta", delta: "HALF_SENTENCE" };
    yield { type: "error", error: new Error("provider failed") };
  }
}

const inspectTool: AgentTool = {
  definition: {
    name: "inspect_manifest",
    description: "Return a deterministic manifest summary",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async execute() {
    return {
      content: [
        "line one",
        "line two",
        "line three",
        "line four",
        "line five",
        "line six",
        "TOOL_RESULT_COMMITTED",
      ].join("\n"),
      isError: false,
    };
  },
};

function shellExecution(stdout: string): ShellExecutionResult {
  const snapshot = {
    content: stdout,
    truncated: false,
    truncatedBy: null,
    totalBytes: Buffer.byteLength(stdout),
    totalLines: stdout.length === 0 ? 0 : stdout.split("\n").length,
    outputBytes: Buffer.byteLength(stdout),
    outputLines: stdout.length === 0 ? 0 : stdout.split("\n").length,
  };
  return {
    stdout: snapshot,
    stderr: { ...snapshot, content: "", totalBytes: 0, totalLines: 0, outputBytes: 0, outputLines: 0 },
    exitCode: 0,
    aborted: false,
    timedOut: false,
  };
}

function response(
  content: string,
  toolCalls: ModelResponse["toolCalls"] = [],
  stopReason = "stop",
): ModelResponse {
  return {
    content,
    toolCalls,
    stopReason,
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 },
  };
}

function externalA2AMessage(options: {
  runId: string;
  sourceRunId: string;
  sourceSessionId: string;
  targetSessionId: string;
  payload: A2AMessage["payload"];
  createdAt: string;
  expiresAt: string;
  index: number;
}): A2AMessage {
  const sourceEndpoint = {
    workspaceId: "local-workspace", sessionId: options.sourceSessionId, runId: options.sourceRunId, laneId: "main",
  };
  const targetEndpoint = {
    workspaceId: "local-workspace", sessionId: options.targetSessionId, runId: options.runId, laneId: "main",
  };
  const idempotencyKey = `external-send-${options.index}`;
  const routeId = createCrossRunRouteId(sourceEndpoint, targetEndpoint, idempotencyKey);
  const fields = {
    conversationId: "external-conversation", threadId: "external-thread",
    correlationId: `external-correlation-${options.index}`,
    visibility: "user" as const, priority: 1, payload: options.payload, expiresAt: options.expiresAt,
  };
  return {
    messageId: createCrossRunMessageId(routeId, fields),
    runId: options.runId,
    ...fields,
    from: "main",
    to: "main",
    createdAt: options.createdAt,
    idempotencyKey,
    delivery: "next-step",
    routeId,
    routeRelationship: "direct",
    routeArtifacts: [],
    sourceEndpoint,
    targetEndpoint,
  };
}

function waitForDurableEvent(
  session: SessionController,
  type: "turn.completed" | "turn.failed" | "turn.waiting",
): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe((runtimeEvent: SessionRuntimeEvent) => {
      if (runtimeEvent.kind !== "event" || runtimeEvent.event.type !== type) return;
      unsubscribe();
      resolve();
    });
  });
}

async function waitForOutput(terminal: MemoryTerminal, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!terminal.output.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for TUI output: ${expected}`);
    await delay(10);
  }
}

async function waitForModelCalls(model: ScriptedModel, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (model.callCount < expected) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} model calls`);
    await delay(10);
  }
}

async function waitForPendingInputs(session: SessionController, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((await session.pendingInputs()).length < expected) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} pending inputs`);
    await delay(10);
  }
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function normalizeTerminalOutput(value: string): string {
  return stripTerminalSequences(value).replace(/\s+/g, " ");
}

function exitFrame(output: string): string {
  const exit = output.lastIndexOf("\x1b[?1049l");
  return exit < 0 ? "" : output.slice(exit);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferredClipboardImage(): {
  promise: Promise<{ bytes: Uint8Array; mimeType: "image/png" }>;
  resolve: (image: { bytes: Uint8Array; mimeType: "image/png" }) => void;
} {
  let resolve = (_image: { bytes: Uint8Array; mimeType: "image/png" }): void => {};
  const promise = new Promise<{ bytes: Uint8Array; mimeType: "image/png" }>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}
