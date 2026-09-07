import {
  defaultProviderAuthContext,
} from "@earendil-works/pi-ai";
import type {
  AuthCheck,
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
import {
  maskSecret,
  inspectEnvironmentCredential,
} from "./onboarding.js";

const MAX_SECRET_INPUT_CHARS = 64 * 1024;

/** Decode terminal bracketed-paste markers even when escape bytes are split across chunks. */
export class BracketedPasteDecoder {
  private static readonly START = "\x1b[200~";
  private static readonly END = "\x1b[201~";
  private buffer = "";
  private inPaste = false;

  push(value: string, emit: (text: string) => void): void {
    this.buffer += value;
    while (this.buffer.length > 0) {
      const marker = this.inPaste ? BracketedPasteDecoder.END : BracketedPasteDecoder.START;
      // A lone ESC is the terminal's cancel key, not a useful partial marker.
      // Treat it immediately so an Escape press can never leave auth pending.
      if (!this.inPaste && this.buffer === "\x1b") {
        emit(this.buffer);
        this.buffer = "";
        break;
      }
      const markerIndex = this.buffer.indexOf(marker);
      if (markerIndex >= 0) {
        if (markerIndex > 0) emit(this.buffer.slice(0, markerIndex));
        this.buffer = this.buffer.slice(markerIndex + marker.length);
        this.inPaste = !this.inPaste;
        continue;
      }
      let preserved = 0;
      for (let length = 1; length < marker.length; length += 1) {
        if (this.buffer.endsWith(marker.slice(0, length))) preserved = length;
      }
      const emitLength = this.buffer.length - preserved;
      if (emitLength > 0) {
        emit(this.buffer.slice(0, emitLength));
        this.buffer = this.buffer.slice(emitLength);
      }
      break;
    }
  }
}

export interface AuthCommandInput {
  readonly action: "login" | "status" | "logout";
  readonly provider: string;
  readonly authType?: AuthType;
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
  /** Render provider-owned OAuth/info events without exposing secrets. */
  readonly onAuthEvent?: (event: AuthEvent) => void;
  /** Render provider-owned prompt metadata before reading the input stream. */
  readonly onAuthPrompt?: (prompt: AuthPrompt) => void;
  /** Choose a provider-owned option by its exact id without reading raw input. */
  readonly onAuthSelect?: (prompt: Extract<AuthPrompt, { type: "select" }>) => Promise<string>;
  /** Edit a non-secret provider field without using the raw secret reader. */
  readonly onAuthText?: (prompt: Extract<AuthPrompt, { type: "text" }>) => Promise<string>;
  /** Render non-secret prompt input without ever receiving a secret value. */
  readonly onAuthInput?: (value: string, prompt: AuthPrompt) => void;
  /** Render secret input progress without receiving the secret itself. */
  readonly onAuthSecretInput?: (length: number, prompt: AuthPrompt) => void;
}

export interface SecretInput {
  readonly isTTY?: boolean;
  readonly signal?: AbortSignal;
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
  & Partial<Pick<PiAiModelPort, "hasProvider" | "providerAuthTypes" | "providers">>;

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
  const authContext = dependencies.authContext
    ?? (dependencies.environment === undefined
      ? undefined
      : {
          ...defaultProviderAuthContext(),
          env: async (name: string): Promise<string | undefined> => (
            dependencies.environment?.[name]
          ),
        });
  const model = dependencies.modelPort
    // Auth commands are provider-scoped and do not open a Run. Use the same
    // complete built-in registry as normal execution.
    ?? createBuiltinModelPort({
      credentials: store,
      ...(authContext === undefined ? {} : { authContext }),
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
  const provider = normalizeProviderId(command.provider);
  if (dependencies.modelPort.hasProvider !== undefined
    && !dependencies.modelPort.hasProvider(provider)) {
    throw new Error(`Unknown provider ${provider}; use a provider from the built-in Pi catalog`);
  }

  if (command.action === "login") {
    const authTypes = dependencies.modelPort.providerAuthTypes?.(provider) ?? ["api_key"];
    const requestedType = command.authType;
    if (requestedType !== undefined && !authTypes.includes(requestedType)) {
      throw new Error(
        `Provider ${provider} does not support ${requestedType === "oauth" ? "OAuth" : "API key"}; `
        + `available methods: ${authTypes.join(", ") || "none"}`,
      );
    }
    const loginType: AuthType | undefined = requestedType
      ?? (authTypes.includes("api_key")
        ? "api_key"
        : authTypes.includes("oauth")
          ? "oauth"
          : undefined);
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
      createSecretInteraction(input, output, dependencies, provider),
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
  let auth: AuthCheck | undefined;
  let authCheckFailed = false;
  try {
    auth = await dependencies.modelPort.checkAuth(provider);
  } catch {
    // Status is a local diagnostic surface. A broken credential helper or
    // unreadable ADC/AWS file should be reported as unknown, not as a command
    // failure that prevents the user from choosing another auth method.
    authCheckFailed = true;
  }
  const authTypes = dependencies.modelPort.providerAuthTypes?.(provider) ?? ["api_key" as const];
  const authIsStored = isStoredAuth(auth);
  const configured = auth !== undefined || stored !== undefined || environmentPresent;
  const result = {
    provider,
    configured,
    auth: "unverified" as const,
    authCheck: authCheckFailed ? "unavailable" as const : "available" as const,
    authMethods: authTypes,
    ...(authCheckFailed ? { authCheckFailed: true } : {}),
    ...(auth?.source === undefined ? {} : { authSource: auth.source }),
    source: stored !== undefined || authIsStored
      ? "saved" as const
      : environmentPresent || auth !== undefined ? "environment" as const : "none" as const,
    ...(stored === undefined ? {} : { storedCredential: credentialSummary(stored) }),
    environmentCredential: environmentPresent || (
      stored === undefined && auth !== undefined && !authIsStored
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

function createSecretInteraction(
  input: SecretInput,
  output: Output,
  callbacks: Pick<UtilityCommandDependencies, "onAuthEvent" | "onAuthPrompt" | "onAuthSelect" | "onAuthText" | "onAuthInput" | "onAuthSecretInput"> = {},
  provider?: string,
) {
  return {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (input.signal?.aborted || prompt.signal?.aborted) throw new Error("Login cancelled");
      const displayPrompt = prompt.type === "select" && provider === "amazon-bedrock"
        ? {
            ...prompt,
            options: prompt.options.filter((option) => option.id !== "credential-chain"),
          }
        : prompt;
      if (prompt.type === "select"
        && displayPrompt.type === "select"
        && displayPrompt.options.length !== prompt.options.length) {
        const event: AuthEvent = {
          type: "info",
          message: "AWS credential chains are detected automatically; configure AWS credentials in the environment or use an AWS profile.",
        };
        callbacks.onAuthEvent?.(event);
        if (callbacks.onAuthEvent === undefined) output.write(`${event.message}\n`);
      }
      callbacks.onAuthPrompt?.(displayPrompt);
      if (displayPrompt.type === "select") {
        if (callbacks.onAuthSelect !== undefined) {
          const answer = await readAuthCallback(displayPrompt, callbacks.onAuthSelect, input.signal);
          const matching = displayPrompt.options.find((option) => option.id === answer);
          if (matching !== undefined) return matching.id;
          throw new Error("Invalid authentication selection");
        }
        const options = displayPrompt.options
          .map((option, index) => `${index + 1}. ${option.label}${option.description === undefined ? "" : ` - ${option.description}`}`)
          .join("\n");
        const answer = await readPromptValue(
          `${prompt.message}\n${options}\nChoose`,
          input,
          output,
          prompt.signal,
          "Selection cannot be empty",
          { hidden: false, onValueChange: (value) => callbacks.onAuthInput?.(value, prompt) },
        );
        const numeric = /^\d+$/.test(answer) ? Number(answer) : Number.NaN;
        if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= displayPrompt.options.length) {
          return displayPrompt.options[numeric - 1]!.id;
        }
        const matching = displayPrompt.options.find((option) => option.id === answer);
        if (matching !== undefined) return matching.id;
        throw new Error("Invalid authentication selection");
      }
      if (prompt.type === "text" && callbacks.onAuthText !== undefined) {
        const answer = await readAuthCallback(prompt, callbacks.onAuthText, input.signal);
        if (answer.length > MAX_SECRET_INPUT_CHARS) throw new Error("Input is too long");
        if (answer.trim().length === 0) throw new Error("Input cannot be empty");
        return answer.trim();
      }
      return readPromptValue(
        prompt.message,
        input,
        output,
        prompt.signal,
        prompt.type === "secret"
          ? "API key cannot be empty"
          : prompt.type === "manual_code"
            ? "Authorization code cannot be empty"
            : "Input cannot be empty",
        {
          // Manual OAuth codes are credentials too; keep them out of terminal
          // echo and callbacks just like API keys.
          hidden: prompt.type === "secret" || prompt.type === "manual_code",
          onLengthChange: (length) => {
            if (prompt.type === "secret" || prompt.type === "manual_code") {
              callbacks.onAuthSecretInput?.(length, prompt);
            }
          },
          onValueChange: (value) => {
            if (prompt.type !== "secret" && prompt.type !== "manual_code") {
              callbacks.onAuthInput?.(value, prompt);
            }
          },
        },
      );
    },
    notify: (event: AuthEvent): void => {
      callbacks.onAuthEvent?.(event);
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
          output.write(
            `${event.message}${event.type === "info" && event.links !== undefined
              ? `\n${event.links.map((link) => `${link.label ?? "Open"}: ${link.url}`).join("\n")}`
              : ""}\n`,
          );
          break;
      }
    },
  };
}

async function readAuthCallback<Prompt extends AuthPrompt>(
  prompt: Prompt,
  read: (prompt: Prompt) => Promise<string>,
  inputSignal: AbortSignal | undefined,
): Promise<string> {
  const signal = AbortSignal.any(
    [inputSignal, prompt.signal].filter((value): value is AbortSignal => value !== undefined),
  );
  if (signal.aborted) throw new Error("Login cancelled");
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Login cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const answer = await Promise.race([cancelled, Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("Login cancelled");
      return read(prompt);
    })]);
    if (signal.aborted) throw new Error("Login cancelled");
    return answer;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
  options: {
    hidden: boolean;
    onValueChange?: (value: string) => void;
    onLengthChange?: (length: number) => void;
  },
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    throw new Error("Secret input requires a TTY");
  }
  output.write(`${message}: `);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const pasteDecoder = new BracketedPasteDecoder();
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
    const processText = (text: string): void => {
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
          options.onLengthChange?.(value.length);
          options.onValueChange?.(value);
          if (!options.hidden) output.write("\b \b");
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          if (value.length >= MAX_SECRET_INPUT_CHARS) {
            finish(new Error("API key is too long"));
            return;
          }
          value += character;
          options.onLengthChange?.(value.length);
          options.onValueChange?.(value);
          if (!options.hidden) output.write(character);
        }
      }
    };
    const onData = (chunk: Buffer | string): void => {
      pasteDecoder.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        processText,
      );
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

/** `checkAuth` can succeed from a saved credential even when the caller did
 * not pass the credential-store metadata separately. Keep status/source labels
 * honest in that race and in injected hosts. */
function isStoredAuth(auth: AuthCheck | undefined): boolean {
  if (auth === undefined) return false;
  if (auth.type === "oauth") return true;
  const source = auth.source?.trim().toLocaleLowerCase();
  return source === "stored credential" || source === "oauth";
}

export function environmentCredentialPresent(
  provider: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  return inspectEnvironmentCredential(provider, environment).present;
}

function normalizeProviderId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length === 0 || !/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    throw new Error("Provider id must contain only letters, numbers, dots, underscores, or hyphens");
  }
  return normalized;
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
  authCheck: "available" | "unavailable";
  authMethods: readonly AuthType[];
  source: "saved" | "environment" | "none";
  storedCredential?: { type: Credential["type"]; mask?: string };
  environmentCredential: boolean;
  authCheckFailed?: boolean;
  authSource?: string;
}): string {
  const source = result.source === "none"
    ? "no credential detected"
    : result.source === "saved"
      ? `saved credential${result.storedCredential?.mask === undefined ? "" : ` (${result.storedCredential.mask})`}`
      : `environment credential${result.authSource === undefined ? "" : ` (${result.authSource})`}`;
  const methods = result.authMethods.length === 0
    ? "no interactive auth"
    : result.authMethods.map((type) => type === "oauth" ? "OAuth" : "API key").join(" / ");
  const check = result.authCheck === "unavailable"
    ? "auth check unavailable"
    : "auth unverified";
  return `${result.provider}: ${result.configured ? "configured" : "not configured"} (${check}; ${methods}; ${source})\n`;
}

function writeResult(output: Output, json: boolean, value: unknown, text: string): void {
  output.write(json ? `${JSON.stringify(value)}\n` : text);
}
