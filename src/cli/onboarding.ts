import type { Readable } from "node:stream";

import type { AuthCheck } from "@earendil-works/pi-ai";
import type { ModelCatalogEntry } from "../model/index.js";
export { UNCONFIGURED_MODEL_SELECTOR as UNCONFIGURED_MODEL } from "../model/index.js";

export interface CredentialStatus {
  provider: string | undefined;
  selectorRecognized: boolean;
  catalogKnown: boolean | undefined;
  credentialEnv: string | undefined;
  credentialPresent: boolean;
  /** Environment values were found, but a provider-specific combination is incomplete. */
  credentialPartial?: boolean;
  /** A fixed mask; the complete environment value is never returned. */
  credentialMask?: string;
  /** Credential source is intentionally non-secret metadata only. */
  credentialSource?: "saved" | "environment";
  /** Provider-owned local auth check; still does not prove a request works. */
  authConfigured?: boolean;
  /** True when the provider check could not complete; missing status is unknown. */
  authCheckFailed?: boolean;
  authSource?: string;
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
  auth?: AuthCheck;
  authCheckFailed?: boolean;
}

/** Known ambient credential names from pi-ai's provider registry. */
export const providerCredentialEnvironmentNames: Readonly<Record<string, readonly string[]>> = {
  "amazon-bedrock": [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
  ],
  "ant-ling": ["ANT_LING_API_KEY"],
  // Match pi-ai's request precedence: the bearer token is checked before the
  // API-key variants, so status and startup guidance describe the credential
  // that will actually be used.
  anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": [
    "GOOGLE_CLOUD_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};

/** Prefer the value users actually need to provide in setup guidance. */
const providerCredentialPrimaryEnvironmentNames: Readonly<Record<string, readonly string[]>> = {
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
};

/**
 * Human-readable requirements for providers whose auth is more than one
 * environment variable. Keep this separate from the first-variable lookup
 * above: `credentialEnv` remains a stable compatibility field, while this
 * hint prevents setup screens from implying that a partial configuration is
 * sufficient.
 */
const providerCredentialRequirements: Readonly<Record<string, string>> = {
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK, or an AWS credential chain (AWS_PROFILE or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_GATEWAY_ID",
  "google-vertex": "GOOGLE_CLOUD_API_KEY, or ADC/service-account credentials with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION",
  "openai-codex": "OAuth via /login openai-codex oauth",
};

export interface EnvironmentCredentialState {
  /** The provider can resolve a complete ambient credential combination. */
  present: boolean;
  /** At least one relevant value exists, but the combination is incomplete. */
  partial: boolean;
  /** Names with non-empty values; values themselves are never returned. */
  detected: readonly string[];
}

/**
 * Inspect environment-only provider configuration without invoking a provider
 * or reading a credential file. Composite providers use their exact required
 * groups so an account id or project id alone is never reported as a key.
 */
export function inspectEnvironmentCredential(
  provider: string,
  environment: NodeJS.ProcessEnv,
): EnvironmentCredentialState {
  const normalized = provider.trim().toLocaleLowerCase();
  const names = providerCredentialEnvironmentNames[normalized] ?? [];
  const detected = names.filter((name) => {
    const value = environment[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  const has = (name: string): boolean => detected.includes(name);
  let present: boolean;
  switch (normalized) {
    case "amazon-bedrock":
      present = has("AWS_BEARER_TOKEN_BEDROCK")
        || has("AWS_PROFILE")
        || (has("AWS_ACCESS_KEY_ID") && has("AWS_SECRET_ACCESS_KEY"))
        || has("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        || has("AWS_CONTAINER_CREDENTIALS_FULL_URI")
        || has("AWS_WEB_IDENTITY_TOKEN_FILE");
      break;
    case "cloudflare-workers-ai":
      present = has("CLOUDFLARE_API_KEY") && has("CLOUDFLARE_ACCOUNT_ID");
      break;
    case "cloudflare-ai-gateway":
      present = has("CLOUDFLARE_API_KEY")
        && has("CLOUDFLARE_ACCOUNT_ID")
        && has("CLOUDFLARE_GATEWAY_ID");
      break;
    case "google-vertex":
      present = has("GOOGLE_CLOUD_API_KEY")
        || (
          has("GOOGLE_APPLICATION_CREDENTIALS")
          && (has("GOOGLE_CLOUD_PROJECT") || has("GCLOUD_PROJECT"))
          && has("GOOGLE_CLOUD_LOCATION")
        );
      break;
    default:
      present = detected.length > 0;
      break;
  }
  return {
    present,
    partial: !present && detected.length > 0,
    detected: Object.freeze(detected),
  };
}

/** Return a setup hint without inspecting or exposing any credential value. */
export function providerCredentialHint(provider: string | undefined): string | undefined {
  if (provider === undefined) return undefined;
  return providerCredentialRequirements[provider.trim().toLocaleLowerCase()];
}

/** Providers that can legitimately rely on a host SDK/file credential chain. */
export function providerSupportsAmbientCredentialChain(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLocaleLowerCase();
  return normalized === "amazon-bedrock" || normalized === "google-vertex";
}

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
    : (separator === 0 ? undefined : trimmed.slice(0, separator).toLocaleLowerCase());
  const selectorRecognized = trimmed.length > 0
    && separator !== 0
    && (separator < 0 || separator < trimmed.length - 1)
    && !/[\s\u0000-\u001f\u007f]/u.test(trimmed);
  const catalogSelector = selectorRecognized && provider !== undefined
    ? (separator < 0 ? `${provider}:${trimmed}` : `${provider}:${trimmed.slice(separator + 1)}`)
    : undefined;
  const catalogKnown = catalogSelector !== undefined && catalog.length > 0
    ? catalog.some((entry) => entry.selector === catalogSelector)
    : undefined;
  const credentialEnvs = provider === undefined
    ? []
    : providerCredentialEnvironmentNames[provider] ?? [];
  const environmentState = provider === undefined
    ? { present: false, partial: false, detected: [] as readonly string[] }
    : inspectEnvironmentCredential(provider, environment);
  const primaryNames = provider === undefined
    ? []
    : providerCredentialPrimaryEnvironmentNames[provider] ?? credentialEnvs;
  const configuredCredentialEnv = environmentState.detected.find((name) => primaryNames.includes(name));
  const credentialEnv = configuredCredentialEnv
    ?? (environmentState.detected.length > 0 || !providerSupportsAmbientCredentialChain(provider)
      ? primaryNames[0] ?? credentialEnvs[0]
      : undefined);
  const secretEnv = environmentState.detected.find((name) => isLikelySecretEnvironmentName(name));
  const raw = secretEnv === undefined ? undefined : environment[secretEnv];
  const normalized = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  const saved = savedCredential !== undefined
    && provider !== undefined
    && savedCredential.provider === provider;
  return {
    provider,
    selectorRecognized,
    catalogKnown,
    credentialEnv,
    credentialPresent: environmentState.present || saved,
    ...(environmentState.partial ? { credentialPartial: true } : {}),
    ...(normalized === undefined ? {} : { credentialMask: maskSecret(normalized) }),
    ...(saved
      ? { credentialSource: "saved" as const }
      : environmentState.detected.length > 0
        ? { credentialSource: "environment" as const }
        : {}),
    authStatus: "unverified",
  };
}

function isLikelySecretEnvironmentName(name: string): boolean {
  return /(?:API_KEY|TOKEN|SECRET|PASSWORD)/u.test(name);
}

/**
 * Merge a provider-owned, side-effect-free auth check into local onboarding
 * state. The check never upgrades `authStatus`: only a real request can verify
 * credentials, and its source is metadata rather than a secret.
 */
export function applyProviderAuthStatus(
  status: CredentialStatus,
  auth: AuthCheck | undefined,
): CredentialStatus {
  if (auth === undefined) return { ...status, authConfigured: false };
  const authSource = auth.source?.trim().toLocaleLowerCase();
  const saved = auth.type === "oauth"
    || authSource === "stored credential"
    || authSource === "oauth";
  return {
    ...status,
    credentialPresent: true,
    credentialPartial: false,
    ...(status.credentialSource === undefined
      ? { credentialSource: saved ? "saved" as const : "environment" as const }
      : {}),
    authConfigured: true,
    ...(auth.source === undefined ? {} : { authSource: auth.source }),
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
  const providerStatus = input.auth === undefined
    ? status
    : applyProviderAuthStatus(status, input.auth);
  const credentialStatus = input.model === undefined || input.model.trim().length === 0
    ? input.auth === undefined
      ? inspectCredential("openrouter:__setup__", input.catalog, input.environment, input.savedCredential)
      : applyProviderAuthStatus(
        inspectCredential("openrouter:__setup__", input.catalog, input.environment, input.savedCredential),
        input.auth,
      )
    : providerStatus;
  const lines: string[] = [];
  if (input.model === undefined || input.model.trim().length === 0) {
    lines.push(
      "Configuration: model is not configured. Choose a provider and model from the built-in catalog.",
      "Use /model to choose a local catalog entry; Esc skips setup and keeps this session open.",
      input.catalog === undefined || input.catalog.length === 0
        ? "Selector: none configured; local model catalog is unavailable/unverified (no candidates loaded)."
        : `Selector: none configured; ${input.catalog.length} local catalog candidate(s) available.`,
    );
  } else {
    lines.push(`Configuration: model ${input.model.trim()} is present.`);
    if (!providerStatus.selectorRecognized) {
      lines.push("Selector: not recognized locally; use /model to choose a provider:model selector.");
    } else if (providerStatus.catalogKnown === true) {
      lines.push("Selector: recognized locally and present in the local catalog.");
    } else if (providerStatus.catalogKnown === false) {
      lines.push("Selector: recognized locally but absent from the local catalog; availability is unverified.");
    } else {
      lines.push("Selector: recognized locally; no local catalog was supplied for verification.");
    }
  }
  if (input.authCheckFailed === true) {
    lines.push(
      "Credential status: the provider's local auth check was unavailable; the next request will verify configuration.",
    );
  } else if (credentialStatus.authConfigured === false || credentialStatus.credentialPartial === true) {
    const requirement = providerCredentialHint(credentialStatus.provider);
    if (requirement !== undefined) {
      lines.push(`Credential configuration is incomplete or missing: ${requirement}.`);
    } else if (credentialStatus.credentialEnv === undefined) {
      lines.push("Credential status: provider credential is not configured; auth is unverified.");
    } else if (!credentialStatus.credentialPresent) {
      lines.push(
        `Credential not detected: ${credentialStatus.credentialEnv}. Set it before the next request; auth remains unverified.`,
      );
    } else {
      lines.push(
        `Credential configuration for ${credentialStatus.provider ?? "the selected provider"} is incomplete; auth remains unverified.`,
      );
    }
  } else if (credentialStatus.credentialSource === "saved") {
    lines.push("Credential source: saved credential; auth is unverified.");
  } else if (credentialStatus.authConfigured === true) {
    lines.push(
      `Credential source: ${credentialStatus.authSource ?? "provider-owned ambient credential"}; auth is unverified.`,
    );
  } else if (credentialStatus.credentialEnv === undefined) {
    lines.push("Credential status: provider credential is not configured; auth is unverified.");
  } else if (!credentialStatus.credentialPresent) {
    lines.push(
      `Credential not detected: ${credentialStatus.credentialEnv}. Set it before the next request; auth remains unverified.`,
    );
  } else {
    const credentialDetail = credentialStatus.credentialMask ?? "configured";
    lines.push(
      `Credential source: ${credentialStatus.credentialEnv} (${credentialDetail}); auth is unverified.`,
    );
  }
  lines.push(
    "Credentials are managed with `/login`, `/logout`, or `nausicaa auth login|status|logout`; this screen never saves or sends a key. Esc skips setup.",
  );
  return lines.join("\n");
}

export function nonInteractiveGuidance(model?: string): string {
  const modelMissing = model === undefined || model.trim().length === 0;
  const selector = modelMissing ? "<provider>:<model-id>" : model.trim();
  const provider = selector.includes(":")
    ? selector.slice(0, selector.indexOf(":")).trim().toLocaleLowerCase()
    : "openrouter";
  const credentialNames = providerCredentialEnvironmentNames[provider] ?? [];
  const credentialHint = providerCredentialHint(provider)
    ?? (credentialNames.length > 0
    ? `${credentialNames.join(" or ")} or \`nausicaa auth login ${provider}\``
    : modelMissing
      ? "the selected provider credential or `nausicaa auth login <provider>`"
      : `the ${provider} provider credential or \`nausicaa auth login ${provider}\``);
  return [
    "Next step (non-interactive):",
    `  nausicaa --print --model ${shellQuote(selector)} ${shellQuote("<task>")}`,
    ...(modelMissing
      ? [
          "  Example: nausicaa --print --model 'openrouter:<model-id>' '<task>'",
          "  Example credential: OPENROUTER_API_KEY or `nausicaa auth login openrouter`",
        ]
      : []),
    `Credential source: ${credentialHint} (presence only; auth is unverified).`,
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
