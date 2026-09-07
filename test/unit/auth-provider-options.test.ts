import { describe, expect, it } from "vitest";

import {
  authProviderChoices,
  type AuthProviderState,
} from "../../src/cli/auth-provider-options.js";
import {
  createBuiltinModelPort,
  type ModelProviderInfo,
} from "../../src/model/index.js";

function provider(overrides: Partial<ModelProviderInfo> = {}): ModelProviderInfo {
  return {
    id: "demo",
    name: "Demo",
    modelCount: 1,
    authTypes: ["api_key", "oauth"],
    ...overrides,
  };
}

describe("authentication provider choices", () => {
  it("keeps installed OpenAI API-key and ChatGPT subscription identities distinct", () => {
    const model = createBuiltinModelPort();
    const providers = model.providers();
    expect(providers.find((entry) => entry.id === "openai")).toMatchObject({
      name: "OpenAI",
      authTypes: ["api_key"],
      apiKeyName: "OpenAI API key",
      apiKeyLogin: true,
    });
    expect(providers.find((entry) => entry.id === "openai-codex")).toMatchObject({
      authTypes: ["oauth"],
      oauthName: "OpenAI (ChatGPT Plus/Pro)",
      oauthSubscription: true,
    });

    const rows = authProviderChoices(providers);
    expect(rows.filter((entry) => entry.provider === "openai")).toEqual([
      expect.objectContaining({
        value: "openai:api_key",
        authType: "api_key",
        label: "OpenAI",
        detail: "api key",
      }),
    ]);
    expect(rows.filter((entry) => entry.provider === "openai-codex")).toEqual([
      expect.objectContaining({
        value: "openai-codex:oauth",
        authType: "oauth",
        label: "OpenAI (ChatGPT Plus/Pro)",
        detail: "subscription",
      }),
    ]);
    expect(rows.map((row) => row.value)).not.toContain("openai:oauth");
    expect(rows.map((row) => row.value)).not.toContain("openai-codex:api_key");
  });

  it("offers exactly the interactive methods advertised by installed providers", () => {
    const providers = createBuiltinModelPort().providers();
    const rows = authProviderChoices(providers);
    for (const entry of providers) {
      expect(rows.filter((row) => row.provider === entry.id).map((row) => row.authType).sort())
        .toEqual(entry.authTypes
          .filter((type) => type !== "api_key" || entry.apiKeyLogin !== false)
          .slice().sort());
    }
    expect(new Set(rows.map((row) => row.value)).size).toBe(rows.length);
  });

  it("does not mislabel installed OpenRouter OAuth as a subscription", () => {
    const rows = authProviderChoices(createBuiltinModelPort().providers());
    expect(rows.find((row) => row.value === "openrouter:oauth")).toMatchObject({
      label: "OpenRouter OAuth",
      detail: "browser sign-in",
      searchText: expect.stringContaining("Sign in with OpenRouter"),
    });
    expect(rows.find((row) => row.value === "openrouter:api_key")).toMatchObject({
      label: "OpenRouter",
      detail: "api key",
    });
  });

  it("omits ambient-only API-key login while retaining supported OAuth", () => {
    const rows = authProviderChoices([
      provider({ id: "ambient", apiKeyLogin: false }),
      provider({ id: "ambient-only", authTypes: ["api_key"], apiKeyLogin: false }),
      provider({ id: "unsupported", authTypes: [] }),
    ]);
    expect(rows.map((row) => row.value)).toEqual(["ambient:oauth"]);
  });

  it("uses provider-owned token labels and OAuth names without inventing subscriptions", () => {
    const rows = authProviderChoices([provider({
      apiKeyName: "Account token",
      oauthName: "Demo Account",
      oauthLoginLabel: "Sign in to Demo",
      oauthSubscription: false,
    })]);
    expect(rows.find((row) => row.authType === "api_key")).toMatchObject({
      label: "Demo",
      detail: "Account token",
      searchText: expect.stringContaining("Account token"),
    });
    expect(rows.find((row) => row.authType === "oauth")).toMatchObject({
      label: "Demo Account",
      detail: "browser sign-in",
      searchText: expect.stringContaining("Sign in to Demo"),
    });
  });

  it("shows a saved method immediately without claiming the other method was saved", () => {
    const rows = authProviderChoices([provider()], new Map([
      ["demo", { savedType: "oauth", checked: false }],
    ]));
    expect(rows.find((row) => row.authType === "oauth")?.status).toBe("saved");
    expect(rows.find((row) => row.authType === "api_key")?.status).toBe("checking...");
    expect(authProviderChoices([provider()]).every((row) => row.status === "checking...")).toBe(true);
  });

  it("keeps API-key environment authentication separate from OAuth status", () => {
    const rows = authProviderChoices([provider()], new Map([
      ["demo", { checked: true, auth: { type: "api_key", source: "DEMO_API_KEY" } }],
    ]));
    expect(rows.find((row) => row.authType === "api_key")?.status).toBe("env: DEMO_API_KEY");
    expect(rows.find((row) => row.authType === "oauth")?.status).toBe("unconfigured");
  });

  it.each([
    ["configured", "environment configured"],
    ["partial", "setup incomplete"],
  ] as const)("scopes %s environment setup status to API-key rows", (environment, status) => {
    const rows = authProviderChoices([provider()], new Map([
      ["demo", { checked: true, environment }],
    ]));
    expect(rows.find((row) => row.authType === "api_key")?.status).toBe(status);
    expect(rows.find((row) => row.authType === "oauth")?.status).toBe("unconfigured");
  });

  it.each(["oauth", "api_key"] as const)("marks only the saved %s method as configured", (savedType) => {
    const states = new Map<string, AuthProviderState>([["demo", {
      checked: true,
      savedType,
      auth: { type: savedType, source: savedType === "oauth" ? "OAuth" : "stored credential" },
    }]]);
    const rows = authProviderChoices([provider()], states);
    expect(rows.find((row) => row.authType === savedType)?.status).toBe("configured");
    expect(rows.find((row) => row.authType !== savedType)?.status)
      .toBe(savedType === "oauth" ? "account configured" : "API key configured");
  });

  it("distinguishes saved credentials from a failed local authentication check", () => {
    const rows = authProviderChoices([provider()], new Map([
      ["demo", { checked: true, failed: true, savedType: "oauth" }],
    ]));
    expect(rows.find((row) => row.authType === "oauth")?.status).toBe("saved; check unavailable");
    const unknown = authProviderChoices([provider()], new Map([
      ["demo", { checked: true, failed: true }],
    ]));
    expect(unknown.every((row) => row.status === "check unavailable")).toBe(true);
  });

  it("sorts configured methods first, their alternate methods next, then remaining OAuth and API-key rows", () => {
    const providers = [
      provider({ id: "zulu", name: "Zulu" }),
      provider({ id: "alpha", name: "Alpha" }),
      provider({ id: "saved", name: "Saved" }),
    ];
    const original = providers.map((entry) => entry.id);
    const rows = authProviderChoices(providers, new Map([
      ["saved", { checked: true, savedType: "api_key", auth: { type: "api_key" } }],
    ]));
    expect(rows.map((row) => row.value)).toEqual([
      "saved:api_key",
      "saved:oauth",
      "alpha:oauth",
      "zulu:oauth",
      "alpha:api_key",
      "zulu:api_key",
    ]);
    expect(providers.map((entry) => entry.id)).toEqual(original);
    expect(providers.every((entry) => entry.authTypes.join(",") === "api_key,oauth")).toBe(true);
  });
});
