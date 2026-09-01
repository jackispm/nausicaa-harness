import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
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

  it("gives a copyable non-interactive next step without accepting a key argument", () => {
    const guidance = nonInteractiveGuidance();
    expect(guidance).toContain("nausicaa --print --model 'openrouter:<model-id>' '<task>'");
    expect(guidance).toContain("OPENROUTER_API_KEY");
    expect(guidance).not.toContain("--api-key");
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
