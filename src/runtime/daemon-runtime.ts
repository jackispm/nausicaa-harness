import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  DaemonActivationRequest,
  DaemonActivator,
  DaemonHostOptions,
  DaemonHostSnapshot,
  DaemonWakeAdmitter,
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
import { JsonlLedger, type Ledger } from "../ledger/index.js";

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

    const session = await createSession(
      { ...options.session, runId: request.runId },
      sessionDeps,
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
}

export interface DaemonRuntime {
  readonly host: DaemonHost;
  readonly activate: DaemonActivator;
  readonly admitWake: DaemonWakeAdmitter;
  start(): Promise<DaemonHostSnapshot>;
  stop(): Promise<DaemonHostSnapshot>;
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
  return {
    host,
    activate,
    admitWake,
    start: () => host.start(),
    stop: () => host.stop(),
  };
}

async function openExistingRunLedger(
  dataDir: string,
  runId: string,
): Promise<Ledger> {
  const ledgerPath = resolve(dataDir, "runs", runId, "ledger.jsonl");
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
  if (options.session.dataDir.trim().length === 0) {
    throw new DaemonRuntimeCompositionError("session.dataDir must not be empty");
  }
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
