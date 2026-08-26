import { describe, expect, it } from "vitest";

import {
  parseSingleJsonObject,
  StructuredJsonError,
} from "../../src/domain/structured-json.js";

describe("parseSingleJsonObject", () => {
  it("extracts a nested object from a fenced or narrated response", () => {
    expect(parseSingleJsonObject(
      "Here is the result:\n```json\n{\"action\":\"revise\",\"meta\":{\"source\":\"teto\"}}\n```",
    )).toEqual({ action: "revise", meta: { source: "teto" } });
  });

  it("rejects responses containing multiple objects", () => {
    expect(() => parseSingleJsonObject(
      '{"action":"silent"} then {"action":"silent"}',
    )).toThrow(StructuredJsonError);
  });

  it("does not treat braces inside strings as structure", () => {
    expect(parseSingleJsonObject(
      '{"note":"keep {this} literal"}',
    )).toEqual({ note: "keep {this} literal" });
  });
});
