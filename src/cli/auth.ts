import type { AuthPrompt, Credential, CredentialStore } from "@earendil-works/pi-ai";

import {
  createNausicaaCredentialStore,
} from "../auth/index.js";
import {
  createOpenRouterModelPort,
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
    ?? createOpenRouterModelPort({ credentials: store });
  return runAuthCommand(command, {
    ...dependencies,
    credentialStore: store,
    modelPort: model,
    output,
  });
}

export async function runAuthCommand(
  command: AuthCommandInput,
  dependencies: UtilityCommandDependencies & {
    readonly credentialStore: CredentialStore;
    readonly modelPort: PiAiModelPort;
  },
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  const provider = command.provider;
  if (provider !== "openrouter") {
    throw new Error(`Provider ${provider} is not configured in this build; available provider: openrouter`);
  }

  if (command.action === "login") {
    const input = dependencies.input ?? process.stdin;
    if (input.isTTY !== true || input.setRawMode === undefined) {
      throw new Error("auth login requires a TTY; set OPENROUTER_API_KEY for non-interactive use");
    }
    const credential = await dependencies.modelPort.login(
      "api_key",
      createSecretInteraction(input, output),
      provider,
    );
    const result = {
      provider,
      status: "saved" as const,
      credential: credential.type,
      path: credentialStorePath(dependencies.credentialStore),
    };
    writeResult(output, command.json, result, `Saved ${provider} API credential at ${result.path}.\n`);
    return 0;
  }

  if (command.action === "logout") {
    const before = await dependencies.credentialStore.read(provider);
    await dependencies.modelPort.logout(provider);
    const result = {
      provider,
      status: before === undefined ? "already-absent" as const : "removed" as const,
      environmentCredential: environmentCredentialPresent(provider, dependencies.environment ?? process.env),
    };
    writeResult(
      output,
      command.json,
      result,
      before === undefined
        ? `No saved ${provider} credential was present.\n`
        : `Removed the saved ${provider} credential. Environment credentials remain available.\n`,
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
      ? environmentPresent ? "environment" as const : "none" as const
      : "saved" as const,
    ...(stored === undefined ? {} : { storedCredential: credentialSummary(stored) }),
    environmentCredential: environmentPresent,
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
      if (prompt.type !== "secret") {
        throw new Error("This provider requested an unsupported login prompt");
      }
      return readSecret(prompt.message, input, output, prompt.signal);
    },
    notify: (event: { type: string; message?: string }): void => {
      if (event.message !== undefined) output.write(`${event.message}\n`);
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

async function readSecret(
  message: string,
  input: SecretInput,
  output: Output,
  signal?: AbortSignal,
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
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("Login cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          if (value.trim().length === 0) {
            finish(new Error("API key cannot be empty"));
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

function environmentCredentialPresent(
  provider: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  const name = provider === "openrouter" ? "OPENROUTER_API_KEY" : undefined;
  const value = name === undefined ? undefined : environment[name];
  return typeof value === "string" && value.trim().length > 0;
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
