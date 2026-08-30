import { lstat, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type {
  DaemonActivationRequest,
  DaemonActivator,
  DaemonHostOptions,
  DaemonHostSnapshot,
  DaemonWakeAdmitter,
  DaemonWakeRequest,
} from "./daemon-host.js";
import { DaemonHost } from "./daemon-host.js";
import {
  LedgerWakeAdmissionAdapter,
  type LedgerWakeAdmissionAdapterOptions,
} from "./daemon-wake-adapter.js";
import {
  SessionController,
  type SessionControllerDeps,
  type SessionControllerOptions,
} from "./session-controller.js";
import { persistedErrorText } from "./redaction.js";
import {
  JsonlLedger,
  LedgerWriterLockedError,
  projectRun,
  type Ledger,
} from "../ledger/index.js";
import {
  recoverRun,
  UnknownToolOperationError,
  type RunRecoveryState,
} from "./recovery.js";
import { projectPendingAdmissions } from "./session-artifacts.js";

/** The minimum surface an activation adapter needs from a SessionController. */
export interface DaemonSession {
  resumeCurrent(): Promise<void>;
  waitForIdle(): Promise<void>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
}

/** Injectable for protocol tests and alternate session implementations. */
export type DaemonSessionFactory = (
  options: SessionControllerOptions,
  deps: SessionControllerDeps,
) => Promise<DaemonSession>;

export class DaemonRuntimeCompositionError extends Error {
  override readonly name = "DaemonRuntimeCompositionError";
}

export class DaemonRuntimeActivationError extends Error {
  override readonly name = "DaemonRuntimeActivationError";
}

export class DaemonRunDiscoveryError extends Error {
  override readonly name = "DaemonRunDiscoveryError";
}

export type DaemonRunDiscoveryFailureKind =
  | "invalid-run-id"
  | "symlink"
  | "missing-ledger"
  | "invalid-ledger"
  | "recovery-required"
  | "busy"
  | "open-failed"
  | "read-failed";

export interface DaemonRunDiscoveryFailure {
  readonly path: string;
  readonly runId?: string;
  readonly kind: DaemonRunDiscoveryFailureKind;
  readonly error: string;
}

export interface DiscoveredDaemonRun {
  readonly runId: string;
  readonly ledgerPath: string;
  readonly pendingInputIds: readonly string[];
  /** Modern Turn left active by a process exit; its input is already delivered. */
  readonly recoverableTurn?: DaemonRecoverableTurn;
  readonly lastOffset: number;
}

export interface DaemonRecoverableTurn {
  readonly turnId: string;
  readonly inputId: string;
  readonly startedAtOffset: number;
}

export interface DaemonRunDiscoveryOptions {
  /** Root containing the conventional `<dataDir>/runs/<runId>/ledger.jsonl`. */
  readonly dataDir: string;
  /** Optional bound to keep a damaged or unexpectedly large directory bounded. */
  readonly maxRuns?: number;
  /** Test/backend seam; the default opens a regular JsonlLedger at ledgerPath. */
  readonly openLedger?: (runId: string, ledgerPath: string) => Promise<Ledger>;
}

export interface DaemonRunDiscoveryResult {
  readonly runs: readonly DiscoveredDaemonRun[];
  readonly failures: readonly DaemonRunDiscoveryFailure[];
}

export interface RecoveredDaemonRun {
  readonly runId: string;
  readonly ledgerPath: string;
  readonly pendingInputIds: readonly string[];
  readonly recoverableTurn?: DaemonRecoverableTurn;
  readonly recovery: RunRecoveryState;
}

export interface DaemonRunRecoveryResult {
  readonly runs: readonly RecoveredDaemonRun[];
  readonly failures: readonly DaemonRunDiscoveryFailure[];
}

export interface DaemonSessionActivatorOptions {
  /** Stable SessionController options shared by every Run activation. */
  readonly session: Omit<SessionControllerOptions, "runId">;
  readonly sessionDeps?: SessionControllerDeps;
  readonly createSession?: DaemonSessionFactory;
}

/**
 * Build the Host activation callback around the existing SessionController.
 *
 * A Host activation is a recovery boundary, not a new conversation surface:
 * the SessionController attaches the Run's Ledger and `resumeCurrent()`
 * promotes the already-admitted input. Closing the controller after each
 * activation keeps the composition restart-safe and avoids a second event
 * source in the daemon.
 */
export function createDaemonSessionActivator(
  options: DaemonSessionActivatorOptions,
): DaemonActivator {
  validateSessionActivatorOptions(options);
  const createSession = options.createSession ?? ((sessionOptions, deps) => (
    SessionController.open(sessionOptions, deps)
  ));
  const sessionDeps = options.sessionDeps ?? {};

  return async (request: DaemonActivationRequest): Promise<void> => {
    validateActivationRequest(request);
    if (request.signal.aborted) {
      throw abortedActivation(request.signal);
    }
    // A daemon activation must carry the Host's atomic fencing boundary. A
    // Session-level commit hook cannot prove that takeover was excluded, so
    // fail closed before opening a session when the Host omitted it.
    if (typeof request.commitLease !== "function") {
      throw new DaemonRuntimeActivationError(
        "Daemon activation requires Host commitLease authority",
      );
    }

    const sessionAssert = request.assertLease;
    const sessionCommit = request.commitLease;
    const configuredAssert = sessionDeps.assertExecutionLease;
    const configuredCommit = sessionDeps.commitExecutionLease;
    const assertExecutionLease = sessionAssert === undefined
      ? configuredAssert
      : configuredAssert === undefined
        ? sessionAssert
        : async (): Promise<void> => {
          await configuredAssert();
          await sessionAssert();
        };
    const activationDeps: SessionControllerDeps = assertExecutionLease === undefined
      ? sessionDeps
      : { ...sessionDeps, assertExecutionLease };
    const commitExecutionLease = sessionCommit === undefined
      ? configuredCommit
      : async <T>(operation: () => Promise<T>): Promise<T> => sessionCommit(async () => {
          await configuredAssert?.();
          return configuredCommit === undefined
            ? operation()
            : configuredCommit(operation);
        });
    const guardedDeps: SessionControllerDeps = commitExecutionLease === undefined
      ? activationDeps
      : { ...activationDeps, commitExecutionLease };
    const session = await createSession(
      { ...options.session, runId: request.runId, closeEdgeCompositionOnClose: false },
      guardedDeps,
    );
    let cancelling = false;
    const cancel = (): void => {
      if (cancelling) return;
      cancelling = true;
      void session.cancel("Daemon activation cancelled")
        .catch(() => undefined);
    };
    request.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (request.signal.aborted) {
        cancel();
        throw abortedActivation(request.signal);
      }
      await session.resumeCurrent();
      await session.waitForIdle();
      if (request.signal.aborted) {
        throw abortedActivation(request.signal);
      }
    } finally {
      request.signal.removeEventListener("abort", cancel);
      await session.close();
    }
  };
}

export interface DaemonRuntimeOptions {
  /** Host lifecycle, lease and concurrency options. */
  readonly host?: Omit<DaemonHostOptions, "admitWake" | "activate">;
  /** Existing Run/session configuration. A wake never creates a new Run. */
  readonly session: Omit<SessionControllerOptions, "runId">;
  readonly sessionDeps?: SessionControllerDeps;
  readonly createSession?: DaemonSessionFactory;
  /** Wake adapter policy; `ledger` is supplied per Run by this composition. */
  readonly wake?: Omit<LedgerWakeAdmissionAdapterOptions, "ledger">;
  /** Override the Ledger opener for tests or another local Ledger backend. */
  readonly openLedger?: (runId: string) => Promise<Ledger>;
  /** Optional live discovery loop. Scans are single-flight and never overlap. */
  readonly reconciliation?: DaemonReconciliationOptions;
  /** Host-owned edge composition shutdown hook, invoked once after Host stop. */
  readonly closeEdgeComposition?: () => void | Promise<void>;
}

export interface DaemonReconciliationOptions {
  readonly intervalMs: number;
  /** Observe successful scans, including isolated per-Run failures. */
  readonly onResult?: (result: DaemonRuntimeRecoveryResult) => void | Promise<void>;
  /** Observe a scan-level failure. Throwing here never terminates the loop. */
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export interface DaemonRuntime {
  readonly host: DaemonHost;
  readonly activate: DaemonActivator;
  readonly admitWake: DaemonWakeAdmitter;
  start(): Promise<DaemonHostSnapshot>;
  stop(): Promise<DaemonHostSnapshot>;
  /** Restore Ledger inputs which were admitted before this daemon started. */
  recoverPendingRuns(): Promise<DaemonRuntimeRecoveryResult>;
}

export interface DaemonRuntimeRecoveryResult extends DaemonRunRecoveryResult {
  readonly queuedRunIds: readonly string[];
}

/**
 * Compose the local daemon Host with durable wake admission and
 * SessionController recovery.
 *
 * The default opener uses `<dataDir>/runs/<runId>/ledger.jsonl` and refuses
 * to create a missing Run. Run creation remains an explicit CLI/session
 * operation, while every daemon wake is an ordinary Ledger input fact.
 */
export async function openDaemonRuntime(
  options: DaemonRuntimeOptions,
): Promise<DaemonRuntime> {
  validateRuntimeOptions(options);
  const sessionDeps = options.sessionDeps ?? {};
  const closeEdgeComposition = closeOnce(
    options.closeEdgeComposition
      ?? options.session.edgeSnapshotProvider?.close
      ?? sessionDeps.edgeSnapshotProvider?.close,
  );
  const activate = createDaemonSessionActivator({
    session: options.session,
    sessionDeps,
    ...(options.createSession === undefined ? {} : { createSession: options.createSession }),
  });
  const openLedger = options.openLedger ?? ((runId: string) => (
    openExistingRunLedger(options.session.dataDir, runId)
  ));
  const tails = new Map<string, Promise<void>>();
  const admitWake: DaemonWakeAdmitter = (request) => {
    const previous = tails.get(request.runId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const ledger = await openLedger(request.runId);
      try {
        const adapter = new LedgerWakeAdmissionAdapter({
          ...(options.wake ?? {}),
          ledger,
        });
        return await adapter.admit(request);
      } finally {
        await ledger.close().catch((error: unknown) => {
          throw new DaemonRuntimeCompositionError(
            `Unable to close wake Ledger: ${persistedErrorText(error)}`,
          );
        });
      }
    });
    const tail = operation.then(() => undefined, () => undefined);
    tails.set(request.runId, tail);
    void tail.finally(() => {
      if (tails.get(request.runId) === tail) tails.delete(request.runId);
    });
    return operation;
  };

  const hostOptions = options.host ?? {};
  const host = await DaemonHost.open({
    ...hostOptions,
    admitWake,
    activate,
  });
  let activeRecovery: Promise<DaemonRuntimeRecoveryResult> | undefined;
  let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
  let reconciliationEnabled = false;
  let stopping = false;
  let stopPromise: Promise<DaemonHostSnapshot> | undefined;

  const performRecovery = async (): Promise<DaemonRuntimeRecoveryResult> => {
    const recovered = await recoverPendingDaemonRuns({
      dataDir: options.session.dataDir,
      openLedger,
    });
    const queuedRunIds: string[] = [];
    for (const run of recovered.runs) {
      const pending = projectPendingAdmissions(run.recovery.events);
      const wakes = pending.map((event): DaemonWakeRequest => ({
        runId: run.runId,
        source: sourceFromCorrelation(event.correlationId),
        dedupeKey: `recovered:${event.payload.inputId}:${event.globalOffset}`,
        wakeId: `recovery:${run.runId}:${event.payload.inputId}`,
        inputId: event.payload.inputId,
        payloadRef: event.payload.messageRef,
        occurredAt: event.occurredAt,
      }));
      if (run.recoverableTurn !== undefined) {
        const turn = run.recoverableTurn;
        const input = projectRun(run.recovery.events, run.runId).inputs.find((candidate) => (
          candidate.inputId === turn.inputId
        ));
        const started = run.recovery.events.find((event) => (
          event.type === "turn.started" && event.payload.turnId === turn.turnId
        ));
        wakes.push({
          runId: run.runId,
          source: "system",
          dedupeKey: `recovered-turn:${turn.turnId}:${turn.startedAtOffset}`,
          wakeId: `recovery:${run.runId}:turn:${turn.turnId}`,
          inputId: turn.inputId,
          ...(input === undefined ? {} : { payloadRef: input.messageRef }),
          ...(started === undefined ? {} : { occurredAt: started.occurredAt }),
        });
      }
      if (wakes.length === 0) continue;
      host.restorePending(wakes);
      queuedRunIds.push(run.runId);
    }
    return {
      ...recovered,
      queuedRunIds,
    };
  };

  const recoverPendingRuns = async (): Promise<DaemonRuntimeRecoveryResult> => {
    if (host.status !== "running" || stopping) {
      throw new DaemonRuntimeCompositionError(
        "recoverPendingRuns requires a running daemon Host",
      );
    }
    if (activeRecovery !== undefined) return activeRecovery;
    const recovery = performRecovery();
    activeRecovery = recovery;
    void recovery.then(
      () => { if (activeRecovery === recovery) activeRecovery = undefined; },
      () => { if (activeRecovery === recovery) activeRecovery = undefined; },
    );
    return recovery;
  };

  const scheduleReconciliation = (): void => {
    const reconciliation = options.reconciliation;
    if (
      reconciliation === undefined
      || !reconciliationEnabled
      || stopping
      || host.status !== "running"
      || reconciliationTimer !== undefined
    ) return;
    const timer = setTimeout(() => {
      if (reconciliationTimer !== timer) return;
      reconciliationTimer = undefined;
      if (!reconciliationEnabled || stopping || host.status !== "running") return;
      void (async () => {
        try {
          const result = await recoverPendingRuns();
          await reconciliation.onResult?.(result);
        } catch (error: unknown) {
          try {
            await reconciliation.onError?.(error);
          } catch {
            // Observability callbacks must not disable future reconciliation.
          }
        } finally {
          scheduleReconciliation();
        }
      })();
    }, reconciliation.intervalMs);
    reconciliationTimer = timer;
    timer.unref?.();
  };

  const start = async (): Promise<DaemonHostSnapshot> => {
    if (stopPromise !== undefined) await stopPromise;
    const snapshot = await host.start();
    stopping = false;
    if (options.reconciliation !== undefined) {
      reconciliationEnabled = true;
      scheduleReconciliation();
    }
    return snapshot;
  };

  const stop = (): Promise<DaemonHostSnapshot> => {
    if (stopPromise !== undefined) return stopPromise;
    stopping = true;
    reconciliationEnabled = false;
    if (reconciliationTimer !== undefined) {
      clearTimeout(reconciliationTimer);
      reconciliationTimer = undefined;
    }
    const operation = (async (): Promise<DaemonHostSnapshot> => {
      await activeRecovery?.catch(() => undefined);
      try {
        return await host.stop();
      } finally {
        await closeEdgeComposition();
      }
    })();
    stopPromise = operation;
    void operation.then(
      () => { if (stopPromise === operation) stopPromise = undefined; },
      () => { if (stopPromise === operation) stopPromise = undefined; },
    );
    return operation;
  };
  return {
    host,
    activate,
    admitWake,
    start,
    stop,
    recoverPendingRuns,
  };
}

function closeOnce(close: (() => void | Promise<void>) | undefined): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = Promise.resolve().then(async () => close?.());
    return closing;
  };
}

/**
 * Discover Runs which already have a regular Ledger on disk.
 *
 * Discovery is deliberately explicit and read-only: it never creates a Run,
 * admits an input, or wakes a Host. A malformed child is returned as a
 * failure so one damaged Ledger cannot hide healthy Runs beside it.
 */
export async function discoverDaemonRuns(
  options: DaemonRunDiscoveryOptions,
): Promise<DaemonRunDiscoveryResult> {
  const normalized = normalizeDiscoveryOptions(options);
  const root = resolve(normalized.dataDir, "runs");
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DaemonRunDiscoveryError(
      `Unable to inspect Run directory: ${persistedErrorText(error)}`,
    );
  });
  if (rootInfo === undefined) return { runs: [], failures: [] };
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DaemonRunDiscoveryError("Run directory must be a regular directory");
  }

  const entries = await readdir(root, { withFileTypes: true });
  const runs: DiscoveredDaemonRun[] = [];
  const failures: DaemonRunDiscoveryFailure[] = [];
  const openLedger = normalized.openLedger ?? ((runId: string, ledgerPath: string) => (
    JsonlLedger.open(ledgerPath)
  ));
  const candidates = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, normalized.maxRuns);

  for (const entry of candidates) {
    const runPath = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      failures.push(failure(runPath, entry.name, "symlink", "Run directory is a symbolic link"));
      continue;
    }
    if (!isSafeRunId(entry.name)) {
      failures.push(failure(runPath, entry.name, "invalid-run-id", "Run directory name is not a safe identifier"));
      continue;
    }
    const ledgerPath = resolve(runPath, "ledger.jsonl");
    if (!isWithin(root, ledgerPath)) {
      failures.push(failure(ledgerPath, entry.name, "invalid-run-id", "Run Ledger escapes the Run directory"));
      continue;
    }
    const ledgerInfo = await lstat(ledgerPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      failures.push(failure(ledgerPath, entry.name, "read-failed", persistedErrorText(error)));
      return undefined;
    });
    if (ledgerInfo === undefined) {
      if (!failures.some((candidate) => candidate.path === ledgerPath)) {
        failures.push(failure(ledgerPath, entry.name, "missing-ledger", "Run Ledger does not exist"));
      }
      continue;
    }
    if (ledgerInfo.isSymbolicLink() || !ledgerInfo.isFile()) {
      failures.push(failure(ledgerPath, entry.name, "symlink", "Run Ledger must be a regular file"));
      continue;
    }

    let ledger: Ledger;
    try {
      ledger = await openLedger(entry.name, ledgerPath);
    } catch (error: unknown) {
      failures.push(failure(
        ledgerPath,
        entry.name,
        error instanceof LedgerWriterLockedError ? "busy" : "open-failed",
        persistedErrorText(error),
      ));
      continue;
    }
    try {
      const events = await ledger.read();
      if (events.length === 0) {
        failures.push(failure(ledgerPath, entry.name, "invalid-ledger", "Run Ledger is empty"));
        continue;
      }
      if (events.some((event) => event.runId !== entry.name)) {
        failures.push(failure(ledgerPath, entry.name, "invalid-ledger", "Ledger contains another Run ID"));
        continue;
      }
      const pendingInputIds = projectPendingAdmissions(events).map((event) => event.payload.inputId);
      const recoverableTurn = projectRecoverableDaemonTurn(events, entry.name);
      runs.push({
        runId: entry.name,
        ledgerPath,
        pendingInputIds,
        ...(recoverableTurn === undefined ? {} : { recoverableTurn }),
        lastOffset: events.at(-1)?.globalOffset ?? 0,
      });
    } catch (error: unknown) {
      failures.push(failure(ledgerPath, entry.name, "invalid-ledger", persistedErrorText(error)));
    } finally {
      try {
        await ledger.close();
      } catch (error: unknown) {
        failures.push(failure(ledgerPath, entry.name, "read-failed", `Unable to close Ledger: ${persistedErrorText(error)}`));
      }
    }
  }
  return { runs, failures };
}

/**
 * Reopen and inspect only Runs which have recoverable work. Inspection never
 * repairs the Ledger before the Host acquires its execution lease and does not
 * create a second daemon journal.
 */
export async function recoverPendingDaemonRuns(
  options: DaemonRunDiscoveryOptions,
): Promise<DaemonRunRecoveryResult> {
  const normalized = normalizeDiscoveryOptions(options);
  const discovered = await discoverDaemonRuns(normalized);
  const runs: RecoveredDaemonRun[] = [];
  const failures = [...discovered.failures];
  const openLedger = normalized.openLedger ?? ((runId: string, ledgerPath: string) => (
    JsonlLedger.open(ledgerPath)
  ));

  for (const candidate of discovered.runs) {
    if (candidate.pendingInputIds.length === 0 && candidate.recoverableTurn === undefined) {
      continue;
    }
    let ledger: Ledger;
    try {
      ledger = await openLedger(candidate.runId, candidate.ledgerPath);
    } catch (error: unknown) {
      failures.push(failure(
        candidate.ledgerPath,
        candidate.runId,
        error instanceof LedgerWriterLockedError ? "busy" : "open-failed",
        persistedErrorText(error),
      ));
      continue;
    }
    try {
      // Discovery can run beside another daemon. Keep it read-only until the
      // Host has acquired the Run's execution lease.
      const recovery = await recoverRun(ledger, candidate.runId, { mode: "inspect" });
      const recoverableTurn = projectRecoverableDaemonTurn(
        recovery.events,
        candidate.runId,
      );
      runs.push({
        runId: candidate.runId,
        ledgerPath: candidate.ledgerPath,
        pendingInputIds: projectPendingAdmissions(recovery.events)
          .map((event) => event.payload.inputId),
        ...(recoverableTurn === undefined ? {} : { recoverableTurn }),
        recovery,
      });
    } catch (error: unknown) {
      failures.push(failure(
        candidate.ledgerPath,
        candidate.runId,
        error instanceof UnknownToolOperationError
          ? "recovery-required"
          : "invalid-ledger",
        persistedErrorText(error),
      ));
    } finally {
      try {
        await ledger.close();
      } catch (error: unknown) {
        failures.push(failure(candidate.ledgerPath, candidate.runId, "read-failed", `Unable to close Ledger: ${persistedErrorText(error)}`));
      }
    }
  }
  return { runs, failures };
}

/** Find a delivered modern input whose Turn has no terminal lifecycle fact. */
function projectRecoverableDaemonTurn(
  events: readonly RunRecoveryState["events"][number][],
  runId: string,
): DaemonRecoverableTurn | undefined {
  const projection = projectRun(events, runId);
  if (projection.run.status !== "running") return undefined;
  const turnId = projection.activeTurnId;
  if (turnId === undefined || turnId.startsWith("legacy:")) return undefined;
  const turn = projection.turns[turnId];
  if (turn?.inputId === undefined) return undefined;
  const started = events.find((event) => (
    event.type === "turn.started" && event.payload.turnId === turnId
  ));
  if (started === undefined) return undefined;
  return {
    turnId,
    inputId: turn.inputId,
    startedAtOffset: started.globalOffset,
  };
}

function normalizeDiscoveryOptions(
  options: DaemonRunDiscoveryOptions,
): DaemonRunDiscoveryOptions & { readonly dataDir: string; readonly maxRuns: number } {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new DaemonRunDiscoveryError("discovery options must be an object");
  }
  if (
    typeof options.dataDir !== "string"
    || options.dataDir.trim().length === 0
    || options.dataDir.includes("\0")
  ) {
    throw new DaemonRunDiscoveryError("dataDir must be a non-empty path without NUL");
  }
  const maxRuns = options.maxRuns ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) {
    throw new DaemonRunDiscoveryError("maxRuns must be a positive safe integer");
  }
  if (options.openLedger !== undefined && typeof options.openLedger !== "function") {
    throw new DaemonRunDiscoveryError("openLedger must be a function");
  }
  return {
    ...options,
    dataDir: resolve(options.dataDir),
    maxRuns,
  };
}

function isSafeRunId(value: string): boolean {
  return (
    value.length > 0
    && value.trim() === value
    && value !== "."
    && value !== ".."
    && !value.includes("\0")
    && !value.includes("/")
    && !value.includes("\\")
  );
}

function isWithin(root: string, target: string): boolean {
  const outside = relative(root, target);
  return outside === "" || (outside !== ".." && !outside.startsWith("../"));
}

function failure(
  path: string,
  runId: string,
  kind: DaemonRunDiscoveryFailureKind,
  error: string,
): DaemonRunDiscoveryFailure {
  return { path, runId, kind, error };
}

async function openExistingRunLedger(
  dataDir: string,
  runId: string,
): Promise<Ledger> {
  if (!isSafeRunId(runId)) {
    throw new DaemonRuntimeCompositionError(
      `Run ID is not a safe identifier: ${persistedErrorText(runId)}`,
    );
  }
  const runsRoot = resolve(dataDir, "runs");
  const runPath = resolve(runsRoot, runId);
  const ledgerPath = resolve(runPath, "ledger.jsonl");
  if (!isWithin(runsRoot, runPath) || !isWithin(runPath, ledgerPath)) {
    throw new DaemonRuntimeCompositionError(`Run ${runId} Ledger escapes the Run directory`);
  }
  const rootInfo = await lstat(runsRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (rootInfo === undefined) {
    throw new DaemonRuntimeCompositionError(`Run ${runId} does not have a Ledger; create the Run before waking it`);
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DaemonRuntimeCompositionError("Run directory must be a regular directory");
  }
  const runInfo = await lstat(runPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (runInfo === undefined) {
    throw new DaemonRuntimeCompositionError(
      `Run ${runId} does not have a Ledger; create the Run before waking it`,
    );
  }
  if (runInfo.isSymbolicLink() || !runInfo.isDirectory()) {
    throw new DaemonRuntimeCompositionError(`Run ${runId} directory is not a regular directory`);
  }
  const info = await lstat(ledgerPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) {
    throw new DaemonRuntimeCompositionError(
      `Run ${runId} does not have a Ledger; create the Run before waking it`,
    );
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DaemonRuntimeCompositionError(`Run ${runId} Ledger is not a regular file`);
  }
  return JsonlLedger.open(ledgerPath);
}

function validateSessionActivatorOptions(
  options: DaemonSessionActivatorOptions,
): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new DaemonRuntimeCompositionError("activator options must be an object");
  }
  if (options.session === null || typeof options.session !== "object") {
    throw new DaemonRuntimeCompositionError("session options are required");
  }
  for (const [field, value] of [
    ["workspace", options.session.workspace],
    ["dataDir", options.session.dataDir],
    ["model", options.session.model],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
      throw new DaemonRuntimeCompositionError(
        `session.${field} must be a non-empty string without NUL`,
      );
    }
  }
  if (
    options.sessionDeps !== undefined
    && (options.sessionDeps === null
      || typeof options.sessionDeps !== "object"
      || Array.isArray(options.sessionDeps))
  ) {
    throw new DaemonRuntimeCompositionError("sessionDeps must be an object");
  }
  if (options.createSession !== undefined && typeof options.createSession !== "function") {
    throw new DaemonRuntimeCompositionError("createSession must be a function");
  }
}

function validateRuntimeOptions(options: DaemonRuntimeOptions): void {
  validateSessionActivatorOptions(options);
  if (options.host !== undefined
    && (options.host === null || typeof options.host !== "object" || Array.isArray(options.host))) {
    throw new DaemonRuntimeCompositionError("host options must be an object");
  }
  if (options.wake !== undefined
    && (options.wake === null || typeof options.wake !== "object" || Array.isArray(options.wake))) {
    throw new DaemonRuntimeCompositionError("wake options must be an object");
  }
  if (options.openLedger !== undefined && typeof options.openLedger !== "function") {
    throw new DaemonRuntimeCompositionError("openLedger must be a function");
  }
  if (options.reconciliation !== undefined) {
    const reconciliation = options.reconciliation;
    if (
      reconciliation === null
      || typeof reconciliation !== "object"
      || Array.isArray(reconciliation)
    ) {
      throw new DaemonRuntimeCompositionError("reconciliation options must be an object");
    }
    if (!Number.isSafeInteger(reconciliation.intervalMs) || reconciliation.intervalMs < 1) {
      throw new DaemonRuntimeCompositionError(
        "reconciliation.intervalMs must be a positive safe integer",
      );
    }
    if (reconciliation.onResult !== undefined && typeof reconciliation.onResult !== "function") {
      throw new DaemonRuntimeCompositionError("reconciliation.onResult must be a function");
    }
    if (reconciliation.onError !== undefined && typeof reconciliation.onError !== "function") {
      throw new DaemonRuntimeCompositionError("reconciliation.onError must be a function");
    }
  }
  if (options.session.dataDir.trim().length === 0) {
    throw new DaemonRuntimeCompositionError("session.dataDir must not be empty");
  }
}

function sourceFromCorrelation(correlationId: string): DaemonWakeRequest["source"] {
  const match = /^daemon:(timer|webhook|file|a2a|user|system):/u.exec(correlationId);
  return match?.[1] as DaemonWakeRequest["source"] ?? "system";
}

function validateActivationRequest(request: DaemonActivationRequest): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new DaemonRuntimeActivationError("activation request must be an object");
  }
  if (
    typeof request.runId !== "string"
    || request.runId.trim().length === 0
    || request.runId.includes("\0")
  ) {
    throw new DaemonRuntimeActivationError("activation runId must be valid");
  }
  if (!Array.isArray(request.wakes) || request.wakes.length === 0) {
    throw new DaemonRuntimeActivationError("activation requires at least one wake");
  }
}

function abortedActivation(signal: AbortSignal): DaemonRuntimeActivationError {
  const detail = signal.reason === undefined ? "Daemon activation cancelled" : persistedErrorText(signal.reason);
  return new DaemonRuntimeActivationError(detail);
}
