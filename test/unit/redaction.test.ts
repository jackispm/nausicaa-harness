import { describe, expect, it } from "vitest";

import {
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
});
