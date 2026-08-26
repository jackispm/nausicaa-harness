import { describe, expect, it } from "vitest";

import { copyToClipboard } from "../../src/cli/clipboard-text.js";

describe("clipboard text boundary", () => {
  it("rejects empty text before touching the platform", async () => {
    await expect(copyToClipboard("")).rejects.toThrow("No assistant message");
  });
});
