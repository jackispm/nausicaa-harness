import { describe, expect, it } from "vitest";

import { selectNewRecoveryFailures } from "../../src/cli/daemon-recovery-reporting.js";
import type { DaemonRunDiscoveryFailure } from "../../src/runtime/index.js";

function failure(
  kind: DaemonRunDiscoveryFailure["kind"],
  error = "broken Ledger",
): DaemonRunDiscoveryFailure {
  return {
    path: "/state/runs/run-1/ledger.jsonl",
    runId: "run-1",
    kind,
    error,
  };
}

describe("daemon recovery reporting", () => {
  it("keeps an interactive Ledger owner silent", () => {
    const reported = new Set<string>();
    expect(selectNewRecoveryFailures([failure("busy")], reported)).toEqual([]);
    expect(reported.size).toBe(0);
  });

  it("reports one failure once while it remains present", () => {
    const reported = new Set<string>();
    const invalid = failure("invalid-ledger");
    expect(selectNewRecoveryFailures([invalid], reported)).toEqual([invalid]);
    expect(selectNewRecoveryFailures([invalid], reported)).toEqual([]);
  });

  it("reports an identical failure only once within one scan", () => {
    const reported = new Set<string>();
    const invalid = failure("invalid-ledger");

    expect(selectNewRecoveryFailures([invalid, invalid], reported)).toEqual([invalid]);
    expect(reported.size).toBe(1);
  });

  it("reports a failure again after an intervening healthy scan", () => {
    const reported = new Set<string>();
    const invalid = failure("invalid-ledger");
    selectNewRecoveryFailures([invalid], reported);
    expect(selectNewRecoveryFailures([], reported)).toEqual([]);
    expect(selectNewRecoveryFailures([invalid], reported)).toEqual([invalid]);
  });
});
