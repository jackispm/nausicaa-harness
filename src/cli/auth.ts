import type {
  AuthContext,
  AuthEvent,
  AuthPrompt,
  AuthType,
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";

import {
  createNausicaaCredentialStore,
} from "../auth/index.js";
import {
  createBuiltinModelPort,
  type PiAiModelPort,
} from "../model/index.js";
import {
  readUserSettings,
  saveUserModel,
  userSettingsPath,
  type UserSettingsOptions,
} from "../config/index.js";
import { maskSecret } from "./onboarding.js";

const MAX_SECRET_INPUT_CHARS = 64 * 1024;

export interface AuthCommandInput {
  readonly action: "login" | "status" | "logout";
  readonly provider: string;
  readonly json: boolean;
}

export interface ConfigCommandInput {
  readonly action: "set-model" | "get-model" | "path";
  readonly model?: string;
  readonly json: boolean;
}

export interface UtilityCommandDependencies {
  readonly userHome?: string;
  readonly credentialStore?: CredentialStore;
  readonly modelPort?: PiAiModelPort;
  readonly input?: SecretInput;
  readonly output?: Output;
  readonly environment?: NodeJS.ProcessEnv;
  /** Optional Pi auth context for deterministic host/tests. */
  readonly authContext?: AuthContext;
}

export interface SecretInput {
  readonly isTTY?: boolean;
  readonly setRawMode?: (mode: boolean) => SecretInput;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): SecretInput;
  off(event: "data", listener: (chunk: Buffer | string) => void): SecretInput;
}

export interface Output {
  write(chunk: string): boolean;
}

/** The small provider-auth surface needed by both top-level CLI and TUI. */
export type AuthModelPort = Pick<PiAiModelPort, "checkAuth" | "login" | "logout">
  & Partial<Pick<PiAiModelPort, "hasProvider" | "providerAuthTypes">>;

/** Execute a non-Run command without opening a Ledger or touching the network. */
export async function runUtilityCommand(
  command: AuthCommandInput | ConfigCommandInput,
  dependencies: UtilityCommandDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  if (isConfigCommand(command)) {
    return runConfigCommand(command, output, dependencies.userHome);
  }

  const credentialOptions = dependencies.userHome === undefined
    ? {}
    : { userHome: dependencies.userHome };
  const store = dependencies.credentialStore
    ?? createNausicaaCredentialStore(credentialOptions);
  const model = dependencies.modelPort
    // Auth commands are provider-scoped and do not open a Run. Use Pi's
    // complete built-in registry here even though the beta execution path
    // remains OpenRouter-only unless `--all-providers` is selected.
    ?? createBuiltinModelPort({
      credentials: store,
      ...(dependencies.authContext === undefined ? {} : { authContext: dependencies.authContext }),
    });
  return runAuthCommand(command, {
    ...dependencies,
    credentialStore: store,
    modelPort: model,
    output,
  });
}

export async function runAuthCommand(
  command: AuthCommandInput,
  dependencies: Omit<UtilityCommandDependencies, "modelPort"> & {
    readonly credentialStore: CredentialStore;
    readonly modelPort: AuthModelPort;
  },
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  const provider = command.provider;
  if (dependencies.modelPort.hasProvider !== undefined
    && !dependencies.modelPort.hasProvider(provider)) {
    throw new Error(`Unknown provider ${provider}; use a provider from the built-in Pi catalog`);
  }

  if (command.action === "login") {
    const authTypes = dependencies.modelPort.providerAuthTypes?.(provider) ?? ["api_key"];
    const loginType: AuthType | undefined = authTypes.includes("api_key")
      ? "api_key"
      : authTypes.includes("oauth")
        ? "oauth"
        : undefined;
    if (loginType === undefined) {
      throw new Error(
        `Provider ${provider} does not expose a supported login type; supported login type: ${authTypes.join(
          ", ",
        ) || "none"}`,
      );
    }
    const input = dependencies.input ?? process.stdin;
    if (input.isTTY !== true || input.setRawMode === undefined) {
      throw new Error(`auth login requires a TTY for the ${provider} ${loginType} flow`);
    }
    const credential = await dependencies.modelPort.login(
      loginType,
      createSecretInteraction(input, output),
      provider,
    );
    const result = {
      provider,
      status: "saved" as const,
      credential: credential.type,
      path: credentialStorePath(dependencies.credentialStore),
    };
    writeResult(output, command.json, result, `Saved ${provider} ${credential.type} credential at ${result.path}.\n`);
    return 0;
  }

  if (command.action === "logout") {
    const before = await dependencies.credentialStore.read(provider);
    await dependencies.modelPort.logout(provider);
    const result = {
      provider,
      status: before === undefined ? "already-absent" as const : "removed" as const,
      environmentCredential: await ambientCredentialConfigured(
        dependencies.modelPort,
        provider,
        dependencies.environment ?? process.env,
      ),
    };
    writeResult(
      output,
      command.json,
      result,
      before === undefined
        ? result.environmentCredential
          ? `No saved ${provider} credential was present. Environment credentials remain available.\n`
          : `No saved ${provider} credential was present.\n`
        : result.environmentCredential
          ? `Removed the saved ${provider} credential. Environment credentials remain available.\n`
          : `Removed the saved ${provider} credential. No environment credential is configured.\n`,
    );
    return 0;
  }

  const stored = await dependencies.credentialStore.read(provider);
  const environment = dependencies.environment ?? process.env;
  const environmentPresent = environmentCredentialPresent(provider, environment);
  const auth = await dependencies.modelPort.checkAuth(provider);
  const result = {
    provider,
    configured: auth !== undefined,
    auth: "unverified" as const,
    source: stored === undefined
      ? environmentPresent || auth !== undefined ? "environment" as const : "none" as const
      : "saved" as const,
    ...(stored === undefined ? {} : { storedCredential: credentialSummary(stored) }),
    environmentCredential: environmentPresent || (
      stored === undefined && auth !== undefined
    ),
    path: credentialStorePath(dependencies.credentialStore),
  };
  writeResult(
    output,
    command.json,
    result,
    formatAuthStatus(result),
  );
  return 0;
}

async function runConfigCommand(
  command: ConfigCommandInput,
  output: Output,
  userHome?: string,
): Promise<number> {
  if (command.action === "path") {
    const path = userSettingsPath(userSettingsOptions(userHome));
    writeResult(output, command.json, { path }, `${path}\n`);
    return 0;
  }
  if (command.action === "get-model") {
    const settings = await readUserSettings(userSettingsOptions(userHome));
    const result = { model: settings.model ?? null, path: userSettingsPath(userSettingsOptions(userHome)) };
    writeResult(
      output,
      command.json,
      result,
      result.model === null ? `No default model is saved.\n${result.path}\n` : `${result.model}\n`,
    );
    return 0;
  }
  if (command.model === undefined) {
    throw new Error("config set-model requires a provider:model selector");
  }
  const result = await saveUserModel(command.model, userSettingsOptions(userHome));
  writeResult(output, command.json, result, `Saved default model ${result.model} at ${result.path}.\n`);
  return 0;
}

function createSecretInteraction(input: SecretInput, output: Output) {
  return {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "select") {
        const options = prompt.options
          .map((option, index) => `${index + 1}. ${option.label}${option.description === undefined ? "" : ` - ${option.description}`}`)
          .join("\n");
        const answer = await readPromptValue(
          `${prompt.message}\n${options}\nChoose`,
          input,
          output,
          prompt.signal,
          "Selection cannot be empty",
        );
        const numeric = Number.parseInt(answer, 10);
        if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
          return prompt.options[numeric - 1]!.id;
        }
        const matching = prompt.options.find((option) => option.id === answer);
        if (matching !== undefined) return matching.id;
        throw new Error("Invalid authentication selection");
      }
      return readPromptValue(
        prompt.message,
        input,
        output,
        prompt.signal,
        prompt.type === "secret" ? "API key cannot be empty" : "Input cannot be empty",
      );
    },
    notify: (event: AuthEvent): void => {
      switch (event.type) {
        case "auth_url":
          output.write(`${event.instructions ?? "Open this URL to authenticate"}: ${event.url}\n`);
          break;
        case "device_code":
          output.write(
            `Open ${event.verificationUri} and enter code ${event.userCode}`
              + `${event.expiresInSeconds === undefined ? "" : ` (expires in ${event.expiresInSeconds}s)`}\n`,
          );
          break;
        case "info":
        case "progress":
          output.write(`${event.message}\n`);
          break;
      }
    },
  };
}

function isConfigCommand(
  command: AuthCommandInput | ConfigCommandInput,
): command is ConfigCommandInput {
  return command.action === "set-model"
    || command.action === "get-model"
    || command.action === "path";
}

function userSettingsOptions(userHome: string | undefined): UserSettingsOptions {
  return userHome === undefined ? {} : { userHome };
}

async function readPromptValue(
  message: string,
  input: SecretInput,
  output: Output,
  signal: AbortSignal | undefined,
  emptyMessage: string,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    throw new Error("Secret input requires a TTY");
  }
  output.write(`${message}: `);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      input.setRawMode!(false);
      input.pause();
      output.write("\n");
      if (error !== undefined) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (character === "\u0003" || character === "\u0004" || character === "\u001b") {
          finish(new Error("Login cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          if (value.trim().length === 0) {
            finish(new Error(emptyMessage));
          } else {
            finish();
          }
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          if (value.length >= MAX_SECRET_INPUT_CHARS) {
            finish(new Error("API key is too long"));
            return;
          }
          value += character;
        }
      }
    };
    const onAbort = (): void => finish(new Error("Login cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    input.setRawMode!(true);
    input.resume();
    input.on("data", onData);
  });
}

function credentialSummary(credential: Credential): { type: Credential["type"]; mask?: string } {
  if (credential.type === "oauth") return { type: credential.type };
  return {
    type: credential.type,
    ...(credential.key === undefined ? {} : { mask: maskSecret(credential.key) }),
  };
}

export function environmentCredentialPresent(
  provider: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  const name = provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined;
  const value = name === undefined ? undefined : environment[name];
  return typeof value === "string" && value.trim().length > 0;
}

async function ambientCredentialConfigured(
  modelPort: AuthModelPort,
  provider: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (environmentCredentialPresent(provider, environment)) return true;
  // Pi's provider-owned check is side-effect-free and understands non-env
  // sources such as ADC/AWS profiles. Treat a configured result as ambient
  // only when no saved credential remains after logout.
  try {
    return (await modelPort.checkAuth(provider)) !== undefined;
  } catch {
    return false;
  }
}

function credentialStorePath(store: CredentialStore): string {
  return "filePath" in store && typeof store.filePath === "string"
    ? store.filePath
    : "<injected credential store>";
}

function formatAuthStatus(result: {
  provider: string;
  configured: boolean;
  source: "saved" | "environment" | "none";
  storedCredential?: { type: Credential["type"]; mask?: string };
  environmentCredential: boolean;
}): string {
  const source = result.source === "none"
    ? "no credential detected"
    : result.source === "saved"
      ? `saved credential${result.storedCredential?.mask === undefined ? "" : ` (${result.storedCredential.mask})`}`
      : "environment credential";
  return `${result.provider}: ${result.configured ? "configured" : "not configured"} (auth unverified; ${source})\n`;
}

function writeResult(output: Output, json: boolean, value: unknown, text: string): void {
  output.write(json ? `${JSON.stringify(value)}\n` : text);
}
