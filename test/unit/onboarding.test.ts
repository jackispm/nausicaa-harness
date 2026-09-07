import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  applyProviderAuthStatus,
  inspectEnvironmentCredential,
  inspectCredential,
  maskSecret,
  nonInteractiveGuidance,
  readAvailableBoundedStdinTask,
  readBoundedStdinTask,
  startupGuidance,
} from "../../src/cli/onboarding.js";
import type { ModelCatalogEntry } from "../../src/model/index.js";

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

describe("CLI onboarding", () => {
  it("reports missing local model and credential state without authenticating", () => {
    expect(inspectCredential(undefined, catalog, {})).toEqual({
      provider: undefined,
      selectorRecognized: false,
      catalogKnown: undefined,
      credentialEnv: undefined,
      credentialPresent: false,
      authStatus: "unverified",
    });

    expect(inspectCredential("openrouter:demo", catalog, {})).toEqual({
      provider: "openrouter",
      selectorRecognized: true,
      catalogKnown: true,
      credentialEnv: "OPENROUTER_API_KEY",
      credentialPresent: false,
      authStatus: "unverified",
    });
  });

  it("recognizes an unqualified OpenRouter catalog selector", () => {
    expect(inspectCredential("demo", catalog, {})).toMatchObject({
      provider: "openrouter",
      selectorRecognized: true,
      catalogKnown: true,
    });
  });

  it("recognizes ambient credentials for non-OpenRouter providers", () => {
    expect(inspectCredential("openai:gpt-5.4", [], { OPENAI_API_KEY: "openai-secret-1234" }))
      .toMatchObject({
        provider: "openai",
        credentialEnv: "OPENAI_API_KEY",
        credentialPresent: true,
        credentialMask: "****1234",
      });
    expect(inspectCredential("anthropic:claude-sonnet", [], { ANTHROPIC_AUTH_TOKEN: "anthropic-token" }))
      .toMatchObject({
        provider: "anthropic",
        credentialEnv: "ANTHROPIC_AUTH_TOKEN",
        credentialPresent: true,
      });
    expect(inspectCredential("anthropic:claude-sonnet", [], {
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_AUTH_TOKEN: "bearer-token",
    })).toMatchObject({
      credentialEnv: "ANTHROPIC_AUTH_TOKEN",
      credentialMask: "****oken",
    });
  });

  it("requires complete composite provider environment credentials", () => {
    expect(inspectEnvironmentCredential("cloudflare-workers-ai", {
      CLOUDFLARE_API_KEY: "key",
    })).toMatchObject({ present: false, partial: true, detected: ["CLOUDFLARE_API_KEY"] });
    expect(inspectCredential("cloudflare-workers-ai:demo", [], {
      CLOUDFLARE_API_KEY: "key",
    })).toMatchObject({
      credentialEnv: "CLOUDFLARE_API_KEY",
      credentialPresent: false,
      credentialPartial: true,
      credentialSource: "environment",
    });
    expect(inspectEnvironmentCredential("cloudflare-workers-ai", {
      CLOUDFLARE_API_KEY: "key",
      CLOUDFLARE_ACCOUNT_ID: "account",
    })).toMatchObject({ present: true, partial: false });
    expect(inspectEnvironmentCredential("cloudflare-ai-gateway", {
      CLOUDFLARE_API_KEY: "key",
      CLOUDFLARE_ACCOUNT_ID: "account",
    })).toMatchObject({ present: false, partial: true });
    expect(inspectEnvironmentCredential("google-vertex", {
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    })).toMatchObject({ present: false, partial: true });
    expect(inspectEnvironmentCredential("amazon-bedrock", {
      AWS_ACCESS_KEY_ID: "access",
    })).toMatchObject({ present: false, partial: true });
    expect(inspectEnvironmentCredential("amazon-bedrock", {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    })).toMatchObject({ present: true, partial: false });
  });

  it("normalizes provider ids in onboarding inspection", () => {
    expect(inspectCredential("OPENAI:gpt-5.4", [], { OPENAI_API_KEY: "key" })).toMatchObject({
      provider: "openai",
      credentialEnv: "OPENAI_API_KEY",
      credentialPresent: true,
    });
    expect(inspectCredential("OPENROUTER:demo", catalog, {})).toMatchObject({
      provider: "openrouter",
      catalogKnown: true,
    });
  });

  it("separates selector syntax, local catalog presence, and provider env knowledge", () => {
    expect(inspectCredential("bad selector", catalog, {})).toMatchObject({
      provider: "openrouter",
      selectorRecognized: false,
      catalogKnown: undefined,
      credentialEnv: "OPENROUTER_API_KEY",
    });
    expect(inspectCredential("openrouter:missing", catalog, {})).toMatchObject({
      selectorRecognized: true,
      catalogKnown: false,
      credentialPresent: false,
    });
    expect(inspectCredential("other:demo", catalog, {})).toMatchObject({
      provider: "other",
      selectorRecognized: true,
      catalogKnown: false,
      credentialEnv: undefined,
      authStatus: "unverified",
    });

    const withoutCatalog = startupGuidance({ model: "openrouter:demo", environment: {} });
    expect(withoutCatalog).toContain("Configuration: model openrouter:demo is present");
    expect(withoutCatalog).toContain("Selector: recognized locally; no local catalog");
    expect(withoutCatalog).toContain("auth remains unverified");
  });

  it("labels an unavailable local catalog during first-run guidance", () => {
    const guidance = startupGuidance({ model: undefined, catalog: [], environment: {} });
    expect(guidance).toContain("local model catalog is unavailable/unverified");
    expect(guidance).not.toContain("/setup");
  });

  it("uses a fixed mask and never returns or renders a complete sentinel key", () => {
    const sentinel = "or-secret-onboarding-1234";
    const status = inspectCredential("openrouter:demo", catalog, {
      OPENROUTER_API_KEY: sentinel,
    });
    const guidance = startupGuidance({
      model: "openrouter:demo",
      catalog,
      environment: { OPENROUTER_API_KEY: sentinel },
    });

    expect(maskSecret(sentinel)).toBe("****1234");
    expect(status).toMatchObject({
      credentialPresent: true,
      credentialMask: "****1234",
      authStatus: "unverified",
    });
    expect(JSON.stringify(status)).not.toContain(sentinel);
    expect(guidance).toContain("OPENROUTER_API_KEY (****1234)");
    expect(guidance).toContain("auth is unverified");
    expect(guidance).not.toContain(sentinel);
  });

  it("uses a non-revealing fixed mask for short and whitespace-only values", () => {
    expect(maskSecret("x")).toBe("****");
    expect(maskSecret("1234")).toBe("****");
    expect(inspectCredential("openrouter:demo", catalog, {
      OPENROUTER_API_KEY: "   ",
    })).not.toHaveProperty("credentialMask");
  });

  it("treats a saved credential as configured without exposing its value", () => {
    const status = inspectCredential("openrouter:demo", catalog, {}, { provider: "openrouter", type: "api_key" });
    expect(status).toMatchObject({ credentialPresent: true, credentialSource: "saved", authStatus: "unverified" });
    const guidance = startupGuidance({ model: "openrouter:demo", catalog, environment: {}, savedCredential: { provider: "openrouter", type: "api_key" } });
    expect(guidance).toContain("saved credential");
    expect(guidance).not.toContain("api_key");
  });

  it("does not attribute a saved credential from another provider", () => {
    expect(inspectCredential(
      "anthropic:demo",
      [],
      {},
      { provider: "openrouter", type: "api_key" },
    )).toMatchObject({ credentialPresent: false });
  });

  it("projects provider-owned auth checks without upgrading verification", () => {
    const local = inspectCredential("anthropic:demo", catalog, {});
    expect(applyProviderAuthStatus(local, { type: "api_key", source: "ANTHROPIC_API_KEY" }))
      .toMatchObject({
        credentialPresent: true,
        credentialSource: "environment",
        authConfigured: true,
        authSource: "ANTHROPIC_API_KEY",
        authStatus: "unverified",
      });
    expect(applyProviderAuthStatus(local, undefined)).toMatchObject({
      credentialPresent: false,
      authConfigured: false,
      authStatus: "unverified",
    });
    expect(startupGuidance({
      model: "anthropic:demo",
      catalog,
      environment: {},
      auth: { type: "api_key", source: "ANTHROPIC_API_KEY" },
    })).toContain("ANTHROPIC_API_KEY");
  });

  it("labels provider-owned saved credentials as saved, not ambient", () => {
    const local = inspectCredential("openai:gpt-5.4", [], {});
    expect(applyProviderAuthStatus(local, {
      type: "api_key",
      source: "stored credential",
    })).toMatchObject({
      credentialPresent: true,
      credentialSource: "saved",
      authConfigured: true,
    });
    expect(applyProviderAuthStatus(local, {
      type: "oauth",
      source: "OAuth",
    })).toMatchObject({
      credentialPresent: true,
      credentialSource: "saved",
      authConfigured: true,
    });
  });

  it("keeps a failed local auth check distinct from a missing credential", () => {
    const status = { ...inspectCredential("openai:gpt-5.4", [], {}), authCheckFailed: true };
    expect(status).toMatchObject({
      credentialPresent: false,
      authCheckFailed: true,
    });
    expect(startupGuidance({
      model: "openai:gpt-5.4",
      environment: {},
      authCheckFailed: true,
    })).toContain("local auth check was unavailable");
  });

  it("explains composite requirements instead of naming a partial variable", () => {
    expect(startupGuidance({
      model: "cloudflare-ai-gateway:demo",
      environment: { CLOUDFLARE_ACCOUNT_ID: "account" },
    })).toContain("CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_GATEWAY_ID");
  });

  it("does not render undefined as a mask for non-secret provider settings", () => {
    const guidance = startupGuidance({
      model: "amazon-bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0",
      environment: { AWS_PROFILE: "work" },
    });
    expect(guidance).toContain("AWS_PROFILE (configured)");
    expect(guidance).not.toContain("(undefined)");
  });

  it("gives a copyable non-interactive next step without accepting a key argument", () => {
    const guidance = nonInteractiveGuidance();
    expect(guidance).toContain("nausicaa --print --model 'openrouter:<model-id>' '<task>'");
    expect(guidance).toContain("OPENROUTER_API_KEY");
    expect(guidance).not.toContain("--api-key");
    const anthropic = nonInteractiveGuidance("anthropic:claude-sonnet-4");
    expect(anthropic).not.toContain("--all-providers");
    expect(anthropic).toContain("nausicaa auth login anthropic");
  });

  it("reads one bounded stdin task and preserves empty EOF as missing input", async () => {
    await expect(readBoundedStdinTask(chunks("  task from stdin\n"), 64))
      .resolves.toBe("task from stdin");
    await expect(readBoundedStdinTask(chunks(" \n\t"), 64)).resolves.toBeUndefined();
    await expect(readBoundedStdinTask(chunks("12345"), 4))
      .rejects.toThrow("4-byte limit");
  });

  it("detects buffered conflicts without hanging on an idle positional pipe", async () => {
    const idle = new PassThrough();
    await expect(readAvailableBoundedStdinTask(idle, 64, 1)).resolves.toBeUndefined();
    idle.destroy();

    const piped = new PassThrough();
    piped.end("conflicting stdin\n");
    await expect(readAvailableBoundedStdinTask(piped, 64, 25))
      .resolves.toBe("conflicting stdin");
  });

  it("detects a conflict as soon as a delayed non-whitespace byte arrives", async () => {
    const piped = new PassThrough();
    const pending = readAvailableBoundedStdinTask(piped, 64, 100);
    setTimeout(() => piped.write("late task"), 5);
    await expect(pending).resolves.toBe("late task");
    piped.destroy();
  });

});

async function* chunks(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}
