export interface WorkerLiveGateResult {
  complete: boolean;
  decision?: { status: string };
}

/** Distinguish a Worker gate hold from incomplete evaluation evidence. */
export function workerLiveVerificationExitCode(
  verified: WorkerLiveGateResult,
): 0 | 2 | 3 {
  if (!verified.complete) {
    return 3;
  }
  return verified.decision?.status === "advance" ? 0 : 2;
}
