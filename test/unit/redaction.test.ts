import { describe, expect, it } from "vitest";

import {
  boundedRedactedText,
  persistedErrorText,
  redactSensitiveText,
  stringifyRedactedJson,
} from "../../src/runtime/redaction.js";

describe("runtime redaction", () => {
  it("redacts Bearer and OpenRouter credentials idempotently", () => {
    const bearer = "bearer_secret_123456";
    const openRouterKey = "sk" + "-or-v1-" + "a".repeat(32);
    const input = `Authorization: Bearer ${bearer}; key=${openRouterKey}`;
    const redacted = redactSensitiveText(input);

    expect(redacted).not.toContain(bearer);
    expect(redacted).not.toContain(openRouterKey);
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it("sanitizes errors and JSON presentation output", () => {
    const key = "sk" + "-or-v1-" + "0".repeat(32);
    const error = persistedErrorText(new Error(`provider key ${key}`));
    const json = stringifyRedactedJson({ type: "failure", error: `Bearer secret-token ${key}` });

    expect(error).not.toContain(key);
    expect(json).not.toContain(key);
    expect(json).not.toContain("secret-token");
    expect(JSON.parse(json)).toMatchObject({ type: "failure" });
  });

  it("redacts Basic auth, common cloud credentials, and JWTs", () => {
    const basic = "ZmFrZS11c2VyOmZha2UtcGFzcw==";
    const quotedBasic = "ZmFrZS1xdW90ZWQtc2VudGluZWw=";
    const awsAccessKey = `AKIA${"A".repeat(16)}`;
    const googleApiKey = `AIza${"b".repeat(35)}`;
    const googleOauthToken = `ya29.${"c".repeat(24)}`;
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJmYWtlLXVzZXIifQ",
      "fake_signature_123456",
    ].join(".");
    const input = [
      `Authorization: Basic ${basic}`,
      `Proxy-Authorization: Basic "${quotedBasic}"`,
      `aws=${awsAccessKey}`,
      `gcp=${googleApiKey}`,
      `oauth=${googleOauthToken}`,
      `jwt=${jwt}`,
    ].join("; ");

    const redacted = redactSensitiveText(input);

    for (const secret of [
      basic,
      quotedBasic,
      awsAccessKey,
      googleApiKey,
      googleOauthToken,
      jwt,
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("Authorization: Basic [REDACTED]");
    expect(redacted).toContain('Proxy-Authorization: Basic "[REDACTED]"');
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it("redacts env assignments and structured diagnostic fields", () => {
    const serviceToken = "service-token-sentinel-123456";
    const awsSecret = "aws-secret-sentinel-123456";
    const apiHeader = "header-key-sentinel-123456";
    const input = [
      `SERVICE_TOKEN=${serviceToken}`,
      `AWS_SECRET_ACCESS_KEY='${awsSecret}'`,
    ].join(" ");
    const json = stringifyRedactedJson({
      diagnostic: input,
      headers: { "x-api-key": apiHeader },
      nested: { service_token: serviceToken },
    });

    expect(json).not.toContain(serviceToken);
    expect(json).not.toContain(awsSecret);
    expect(json).not.toContain(apiHeader);
    expect(JSON.parse(json)).toEqual({
      diagnostic: "SERVICE_TOKEN=[REDACTED] AWS_SECRET_ACCESS_KEY='[REDACTED]'",
      headers: { "x-api-key": "[REDACTED]" },
      nested: { service_token: "[REDACTED]" },
    });
    expect(redactSensitiveText(json)).toBe(json);
  });

  it("redacts camelCase credentials at each persistent text boundary", () => {
    const apiKey = "camel-api-key-sentinel-123456";
    const accessToken = "camel-access-token-sentinel-123456";
    const clientSecret = "camel-client-secret-sentinel-123456";
    const refreshToken = "camel-refresh-token-sentinel-123456";
    const error = persistedErrorText(new Error(`clientSecret=${clientSecret}`));
    const bounded = boundedRedactedText(
      `providerAccessToken=${accessToken} ${"diagnostic ".repeat(20)}`,
      48,
    );
    const json = stringifyRedactedJson({
      apiKey,
      providerAccessToken: accessToken,
      oauthClientSecret: clientSecret,
      refreshToken,
    });

    expect(error).toBe("clientSecret=[REDACTED]");
    expect(bounded).not.toContain(accessToken);
    expect(bounded).toHaveLength(48);
    expect(JSON.parse(json)).toEqual({
      apiKey: "[REDACTED]",
      providerAccessToken: "[REDACTED]",
      oauthClientSecret: "[REDACTED]",
      refreshToken: "[REDACTED]",
    });
    for (const secret of [apiKey, accessToken, clientSecret, refreshToken]) {
      expect(json).not.toContain(secret);
    }
    expect(redactSensitiveText(json)).toBe(json);
  });

  it("keeps JSON valid when an assignment is the final string content", () => {
    const serviceToken = "json-tail-service-token-sentinel";
    const accessToken = "json-tail-access-token-sentinel";
    const serviceJson = stringifyRedactedJson({
      diagnostic: `SERVICE_TOKEN=${serviceToken}`,
    });
    const camelJson = stringifyRedactedJson({
      diagnostic: `providerAccessToken=${accessToken}`,
    });

    expect(JSON.parse(serviceJson)).toEqual({ diagnostic: "SERVICE_TOKEN=[REDACTED]" });
    expect(JSON.parse(camelJson)).toEqual({ diagnostic: "providerAccessToken=[REDACTED]" });
    expect(serviceJson).not.toContain(serviceToken);
    expect(camelJson).not.toContain(accessToken);
  });

  it("keeps escaped assignment quotes valid and idempotent", () => {
    const serviceToken = "json-quoted-service-token-sentinel";
    const basic = "json-quoted-basic-sentinel";
    const value = {
      diagnostic: `SERVICE_TOKEN="${serviceToken}" Authorization: Basic "${basic}"`,
    };
    const json = stringifyRedactedJson(value);

    expect(JSON.parse(json)).toEqual({
      diagnostic: 'SERVICE_TOKEN="[REDACTED]" Authorization: Basic "[REDACTED]"',
    });
    expect(json).not.toContain(serviceToken);
    expect(json).not.toContain(basic);
    expect(redactSensitiveText(json)).toBe(json);
  });

  it("preserves JSON whitespace and numeric lexemes while scrubbing", () => {
    const input = '{\n  "n": 9007199254740993,\n  "diagnostic": "SERVICE_TOKEN=tail-secret"\n}\n';
    const redacted = redactSensitiveText(input);

    expect(redacted).toBe('{\n  "n": 9007199254740993,\n  "diagnostic": "SERVICE_TOKEN=[REDACTED]"\n}\n');
    expect(JSON.parse(redacted).n).toBe(9007199254740992);
  });

  it("keeps a JSON string root valid while scrubbing its content", () => {
    const redacted = redactSensitiveText(JSON.stringify('SERVICE_TOKEN="root-secret"'));

    expect(redacted).toBe(JSON.stringify('SERVICE_TOKEN="[REDACTED]"'));
    expect(JSON.parse(redacted)).toBe('SERVICE_TOKEN="[REDACTED]"');
  });

  it("does not redact ordinary authentication and token-related prose", () => {
    const input = [
      "Basic authentication is enabled",
      "token budget=4096",
      "MODEL_TOKEN_LIMIT=8192",
      "release=v1.2.3",
      "authorization is host-owned",
      "public_key=example",
      "apiKeyHint=environment variable name",
      "accessTokenCount=2",
      "clientSecretPolicy=host-owned",
      "refreshTokens=disabled",
    ].join("; ");

    expect(redactSensitiveText(input)).toBe(input);
  });

  it("keeps persisted errors within the configured length", () => {
    const token = "bounded-secret-sentinel-123456";
    const error = persistedErrorText(
      new Error(`SERVICE_TOKEN=${token} ${"diagnostic ".repeat(1_000)}`),
      "fallback",
      64,
    );

    expect(error).toHaveLength(64);
    expect(error).not.toContain(token);
    expect(error).toContain("[REDACTED]");
    expect(error.endsWith("[TRUNCATED]")).toBe(true);
    expect(boundedRedactedText("too long", 5)).toHaveLength(5);
    expect(boundedRedactedText("too long", 0)).toBe("");
    expect(boundedRedactedText("x".repeat(2_000), Number.POSITIVE_INFINITY).length)
      .toBeLessThanOrEqual(1_024);
  });
});
