import { describe, expect, it } from "vitest";

import {
  DAEMON_CONTROL_PROTOCOL_VERSION,
  DaemonControlProtocolError,
  parseDaemonControlFrame,
  parseDaemonControlLine,
  serializeDaemonControlFrame,
  serializeDaemonControlRequest,
  type DaemonControlFrame,
} from "../../src/runtime/index.js";

describe("daemon public JSONL contract", () => {
  it("serializes requests with an explicit protocol version", () => {
    const encoded = serializeDaemonControlRequest({
      id: "request-1",
      method: "status",
      params: { extension: "ignored-by-v1" },
    });

    expect(encoded).toBe(
      '{"version":1,"id":"request-1","method":"status","params":{"extension":"ignored-by-v1"}}\n',
    );
  });

  it("round-trips response, host event, and Run event frames without dropping extension fields", () => {
    const frames = [
      {
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        kind: "response",
        id: "request-1",
        ok: true,
        result: { status: "running" },
        extension: { source: "future-daemon" },
      },
      {
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        kind: "event",
        event: { type: "state", snapshot: { status: "running" } },
      },
      {
        version: DAEMON_CONTROL_PROTOCOL_VERSION,
        kind: "run.event",
        observation: {
          type: "source_error",
          runId: "run-1",
          cursor: "offset:2",
          error: "temporary read failure",
        },
      },
    ] as const;

    for (const frame of frames) {
      const encoded = serializeDaemonControlFrame(frame as unknown as DaemonControlFrame);
      expect(encoded.endsWith("\n")).toBe(true);
      expect(parseDaemonControlLine(encoded.slice(0, -1))).toEqual(frame);
      expect(parseDaemonControlLine(`${encoded.slice(0, -1)}\r`)).toEqual(frame);
    }
  });

  it.each([
    ["unsupported version", { version: 2, kind: "response", id: "x", ok: true }],
    ["unsupported kind", { version: 1, kind: "notice" }],
    ["missing event", { version: 1, kind: "event" }],
    ["invalid response error", { version: 1, kind: "response", id: "x", ok: false }],
  ])("rejects %s", (_label, frame) => {
    expect(() => parseDaemonControlFrame(frame)).toThrow(DaemonControlProtocolError);
  });

  it("rejects malformed JSONL lines before they reach a caller", () => {
    expect(() => parseDaemonControlLine("not-json")).toThrow(/valid JSON/u);
    expect(() => parseDaemonControlLine("\r")).toThrow(/non-empty/u);
  });
});
