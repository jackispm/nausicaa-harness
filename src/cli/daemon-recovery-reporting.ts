import type { DaemonRunDiscoveryFailure } from "../runtime/index.js";

/**
 * Select recovery failures which became observable since the previous scan.
 * A live Ledger writer is expected ownership coordination, not a user-facing
 * daemon fault, so `busy` never enters the reported set.
 */
export function selectNewRecoveryFailures(
  failures: readonly DaemonRunDiscoveryFailure[],
  previouslyReported: Set<string>,
): readonly DaemonRunDiscoveryFailure[] {
  const current = new Set<string>();
  const fresh: DaemonRunDiscoveryFailure[] = [];
  for (const failure of failures) {
    if (failure.kind === "busy") continue;
    const key = recoveryFailureKey(failure);
    if (current.has(key)) continue;
    current.add(key);
    if (!previouslyReported.has(key)) fresh.push(failure);
  }
  previouslyReported.clear();
  for (const key of current) previouslyReported.add(key);
  return fresh;
}

function recoveryFailureKey(failure: DaemonRunDiscoveryFailure): string {
  return `${failure.path}\u0000${failure.kind}\u0000${failure.error}`;
}
