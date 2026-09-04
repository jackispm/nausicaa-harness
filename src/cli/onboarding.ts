import type { Readable } from "node:stream";

import type { ModelCatalogEntry } from "../model/index.js";
export { UNCONFIGURED_MODEL_SELECTOR as UNCONFIGURED_MODEL } from "../model/index.js";

export interface CredentialStatus {
  provider: string | undefined;
  selectorRecognized: boolean;
  catalogKnown: boolean | undefined;
  credentialEnv: string | undefined;
  credentialPresent: boolean;
  /** A fixed mask; the complete environment value is never returned. */
  credentialMask?: string;
  /** Credential source is intentionally non-secret metadata only. */
  credentialSource?: "saved" | "environment";
  authStatus: "unverified";
}

export interface SavedCredentialStatus {
  provider: string;
  type: "api_key" | "oauth";
}

export interface StartupGuidanceInput {
  model: string | undefined;
  catalog?: readonly ModelCatalogEntry[];
  environment?: NodeJS.ProcessEnv;
  savedCredential?: SavedCredentialStatus;
}

const providerCredentialEnvs: Readonly<Record<string, string>> = {
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * Inspect only local selector/catalog/env state. This function never performs
 * auth, network, persistence, or provider calls.
 */
export function inspectCredential(
  model: string | undefined,
  catalog: readonly ModelCatalogEntry[] = [],
  environment: NodeJS.ProcessEnv = process.env,
  savedCredential?: SavedCredentialStatus,
): CredentialStatus {
  const trimmed = model?.trim() ?? "";
  const separator = trimmed.indexOf(":");
  const provider = separator < 0
    ? (trimmed.length === 0 ? undefined : "openrouter")
    : (separator === 0 ? undefined : trimmed.slice(0, separator));
  const selectorRecognized = trimmed.length > 0
    && separator !== 0
    && (separator < 0 || separator < trimmed.length - 1)
    && !/[\s\u0000-\u001f\u007f]/u.test(trimmed);
  const catalogSelector = selectorRecognized && provider !== undefined
    ? (separator < 0 ? `${provider}:${trimmed}` : trimmed)
    : undefined;
  const catalogKnown = catalogSelector !== undefined && catalog.length > 0
    ? catalog.some((entry) => entry.selector === catalogSelector)
    : undefined;
  const credentialEnv = provider === undefined ? undefined : providerCredentialEnvs[provider];
  const raw = credentialEnv === undefined ? undefined : environment[credentialEnv];
  const normalized = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  const saved = savedCredential !== undefined
    && provider !== undefined
    && savedCredential.provider === provider;
  return {
    provider,
    selectorRecognized,
    catalogKnown,
    credentialEnv,
    credentialPresent: normalized !== undefined || saved,
    ...(normalized === undefined ? {} : { credentialMask: maskSecret(normalized) }),
    ...(saved ? { credentialSource: "saved" as const } : normalized === undefined ? {} : { credentialSource: "environment" as const }),
    authStatus: "unverified",
  };
}

/** Never expose more than the final four characters of an environment value. */
export function maskSecret(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 4) return "****";
  return `****${normalized.slice(-4)}`;
}

export function startupGuidance(input: StartupGuidanceInput): string {
  const status = inspectCredential(
    input.model,
    input.catalog,
    input.environment,
    input.savedCredential,
  );
  const credentialStatus = input.model === undefined || input.model.trim().length === 0
    ? inspectCredential("openrouter:__setup__", input.catalog, input.environment, input.savedCredential)
    : status;
  const lines: string[] = [];
  if (input.model === undefined || input.model.trim().length === 0) {
    lines.push(
      "Configuration: model is not configured. OpenRouter is the current beta provider.",
      "Use /model to choose a local catalog entry; Esc skips setup and keeps this session open.",
      input.catalog === undefined || input.catalog.length === 0
        ? "Selector: none configured; local model catalog is unavailable/unverified (no candidates loaded)."
        : `Selector: none configured; ${input.catalog.length} local catalog candidate(s) available.`,
    );
  } else {
    lines.push(`Configuration: model ${input.model.trim()} is present.`);
    if (!status.selectorRecognized) {
      lines.push("Selector: not recognized locally; use /model to choose a provider:model selector.");
    } else if (status.catalogKnown === true) {
      lines.push("Selector: recognized locally and present in the local catalog.");
    } else if (status.catalogKnown === false) {
      lines.push("Selector: recognized locally but absent from the local catalog; availability is unverified.");
    } else {
      lines.push("Selector: recognized locally; no local catalog was supplied for verification.");
    }
  }
  if (credentialStatus.credentialSource === "saved") {
    lines.push("Credential source: saved credential; auth is unverified.");
  } else if (credentialStatus.credentialEnv === undefined) {
    lines.push("Credential status: provider environment variable is unknown; auth is unverified.");
  } else if (!credentialStatus.credentialPresent) {
    lines.push(
      `Credential not detected: ${credentialStatus.credentialEnv}. Set it before the next request; auth remains unverified.`,
    );
  } else {
    lines.push(
      `Credential source: ${credentialStatus.credentialEnv} (${credentialStatus.credentialMask}); auth is unverified.`,
    );
  }
  lines.push(
    "Credentials are managed with `/login`, `/logout`, or `nausicaa auth login|status|logout`; this screen never saves or sends a key. Esc skips setup.",
  );
  return lines.join("\n");
}

export function nonInteractiveGuidance(model?: string): string {
  const selector = model === undefined || model.trim().length === 0
    ? "openrouter:<model-id>"
    : model.trim();
  return [
    "Next step (non-interactive):",
    `  nausicaa --print --model ${shellQuote(selector)} ${shellQuote("<task>")}`,
    "Credential source: OPENROUTER_API_KEY or `nausicaa auth login` (presence only; auth is unverified).",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Read one bounded task from a non-TTY stream. The stream is consumed once. */
export async function readBoundedStdinTask(
  input: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes = 128 * 1024,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error(`stdin task exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length === 0 ? undefined : text;
}

/** Probe a positional invocation's pipe without waiting forever on an idle parent-owned fd. */
export async function readAvailableBoundedStdinTask(
  input: Readable,
  maxBytes = 128 * 1024,
  waitMs = 25,
): Promise<string | undefined> {
  if (input.readableEnded) return undefined;
  return new Promise<string | undefined>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let total = 0;
    const cleanup = (value: string | undefined): void => {
      if (timer !== undefined) clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      if (value === undefined) {
        input.pause();
        (input as Readable & { unref?: () => void }).unref?.();
      }
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (timer !== undefined) clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.pause();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        fail(new Error(`stdin task exceeds the ${maxBytes}-byte limit`));
        return;
      }
      const text = buffer.toString("utf8").trim();
      if (text.length > 0) cleanup(text);
    };
    const onEnd = (): void => cleanup(undefined);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
    timer = setTimeout(() => cleanup(undefined), waitMs);
  });
}
