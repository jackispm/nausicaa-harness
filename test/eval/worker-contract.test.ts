import { describe, expect, it } from "vitest";

import {
  WORKER_CONTROL_ARM,
  WORKER_EVAL_MANIFEST,
  WORKER_TREATMENT_ARM,
  hashWorkerManifest,
  validateWorkerManifest,
  type WorkerEvalManifest,
} from "./worker-contract.js";
import { balancedWorkerArmOrder } from "./worker-runner.js";

describe("Phase 3 Worker evaluation contract", () => {
  it("freezes a valid two-arm manifest with identical per-arm budgets", () => {
    expect(() => validateWorkerManifest(WORKER_EVAL_MANIFEST)).not.toThrow();
    expect(WORKER_EVAL_MANIFEST.manifestHash).toBe(
      hashWorkerManifest(WORKER_EVAL_MANIFEST),
    );
    expect(WORKER_EVAL_MANIFEST.arms.map((arm) => arm.id)).toEqual([
      WORKER_CONTROL_ARM,
      WORKER_TREATMENT_ARM,
    ]);
    expect(WORKER_EVAL_MANIFEST.arms[0]!.budget).toEqual(
      WORKER_EVAL_MANIFEST.arms[1]!.budget,
    );
    expect(Object.isFrozen(WORKER_EVAL_MANIFEST)).toBe(true);
    expect(Object.isFrozen(WORKER_EVAL_MANIFEST.arms[0]!.budget)).toBe(true);
  });

  it("rotates arm order deterministically across adjacent pairs", () => {
    const order = (pairIndex: number) => balancedWorkerArmOrder(
      WORKER_EVAL_MANIFEST,
      pairIndex,
    ).map((arm) => arm.id);

    expect(order(0)).toEqual([WORKER_CONTROL_ARM, WORKER_TREATMENT_ARM]);
    expect(order(1)).toEqual([WORKER_TREATMENT_ARM, WORKER_CONTROL_ARM]);
    expect(order(2)).toEqual(order(0));
    expect(order(3)).toEqual(order(1));
  });

  it("rejects any mutation even when the manifest hash is recomputed", () => {
    const changed = structuredClone(WORKER_EVAL_MANIFEST) as WorkerEvalManifest;
    changed.arms[1]!.budget.maxRequests += 1;
    changed.manifestHash = hashWorkerManifest(changed);

    expect(() => validateWorkerManifest(changed)).toThrow(/frozen contract/);
  });
});
