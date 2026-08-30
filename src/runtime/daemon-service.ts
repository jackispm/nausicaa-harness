import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, link, lstat, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { Clock } from "../domain/index.js";
import { systemClock } from "../domain/index.js";
import {
  assertRealDirectory,
  assertRegularFile,
  ensureRealDirectory,
  openNoFollow,
  syncDirectory,
} from "../ledger/file-utils.js";
import { boundedRedactedText } from "./redaction.js";
import {
  DAEMON_SERVICE_PROBE_VERSION,
  probeDaemonService,
  type DaemonServiceProbePort,
  type DaemonServiceProbeRequest,
} from "./daemon-service-probe.js";

export const DAEMON_SERVICE_DESCRIPTOR_VERSION = 1 as const;

const DESCRIPTOR_NAME = "daemon-service.json";
const LOCK_NAME = "daemon-service.lock";
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_ERROR_LENGTH = 512;
const MAX_IDENTITY_LENGTH = 256;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 2_000;
const DEFAULT_TERM_TIMEOUT_MS = 2_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;
const DEFAULT_LOCK_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 60_000;

export type DaemonServiceDescriptorState = "starting" | "ready" | "draining" | "failed";

export interface DaemonServiceFailure {
  readonly code: string;
  readonly message: string;
}

export interface DaemonServiceDescriptor {
  readonly version: typeof DAEMON_SERVICE_DESCRIPTOR_VERSION;
  readonly probeVersion: typeof DAEMON_SERVICE_PROBE_VERSION;
  readonly state: DaemonServiceDescriptorState;
  readonly pid: number;
  readonly processStartId: string;
  readonly instanceToken: string;
  readonly controlProtocolVersion: number;
  readonly socketPath: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly failure?: DaemonServiceFailure;
}

export interface DaemonServiceProcessIdentity {
  readonly pid: number;
  readonly processStartId: string;
  readonly instanceToken: string;
}

export type DaemonServiceProcessObservation =
  | { readonly status: "running"; readonly processStartId: string }
  | { readonly status: "missing" }
  | { readonly status: "inaccessible"; readonly error?: unknown };

export interface DaemonServiceChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface DaemonServiceSpawnRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly detached: true;
  readonly descriptorPath: string;
  readonly socketPath: string;
  readonly instanceToken: string;
  readonly controlProtocolVersion: number;
}

export interface DaemonServiceSpawnResult {
  readonly pid: number;
  readonly exited: Promise<DaemonServiceChildExit>;
}

export type DaemonServiceSpawnPort = (
  request: DaemonServiceSpawnRequest,
) => Promise<DaemonServiceSpawnResult>;

export type DaemonServiceInspectProcessPort = (
  pid: number,
) => Promise<DaemonServiceProcessObservation>;

export interface DaemonServiceShutdownRequest {
  readonly identity: DaemonServiceProcessIdentity;
  readonly probe: DaemonServiceProbeRequest;
}

export type DaemonServiceShutdownPort = (
  request: DaemonServiceShutdownRequest,
) => Promise<void>;

export interface DaemonServiceSignalRequest {
  readonly identity: DaemonServiceProcessIdentity;
  readonly signal: "SIGTERM" | "SIGKILL";
}

export type DaemonServiceSignalPort = (
  request: DaemonServiceSignalRequest,
) => Promise<void>;

export interface DaemonServiceSocketIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
}

export type DaemonServiceSocketObservation =
  | { readonly status: "absent" }
  | { readonly status: "socket"; readonly identity: DaemonServiceSocketIdentity }
  | { readonly status: "other" }
  | { readonly status: "inaccessible"; readonly error?: unknown };

export type DaemonServiceInspectSocketPort = (
  socketPath: string,
) => Promise<DaemonServiceSocketObservation>;

export type DaemonServiceRemoveSocketPort = (
  socketPath: string,
  expected: DaemonServiceSocketIdentity,
) => Promise<"removed" | "absent" | "replaced" | "inaccessible">;

export interface DaemonServiceDependencies {
  readonly spawn: DaemonServiceSpawnPort;
  readonly inspectProcess: DaemonServiceInspectProcessPort;
  readonly probe: DaemonServiceProbePort;
  readonly requestShutdown: DaemonServiceShutdownPort;
  readonly signal: DaemonServiceSignalPort;
  readonly inspectSocket?: DaemonServiceInspectSocketPort;
  readonly removeSocket?: DaemonServiceRemoveSocketPort;
}

export interface DaemonServiceManagerOptions {
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly executable: string;
  readonly argv?: readonly string[];
  readonly controlProtocolVersion: number;
  readonly dependencies: DaemonServiceDependencies;
  readonly clock?: Clock;
  readonly monotonicNow?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly createInstanceToken?: () => string;
  readonly readyTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly gracefulTimeoutMs?: number;
  readonly termTimeoutMs?: number;
  readonly killTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}

export type DaemonServiceStatus =
  | { readonly state: "stopped" }
  | {
      readonly state: "starting" | "ready" | "draining";
      readonly pid: number;
      readonly since: string;
      readonly controlProtocolVersion: number;
    }
  | {
      readonly state: "failed";
      readonly pid?: number;
      readonly since?: string;
      readonly error: DaemonServiceFailure;
    }
  | {
      readonly state: "stale";
      readonly pid: number;
      readonly since: string;
      readonly reason: "process_missing" | "process_identity_changed";
    };

interface ServiceLocation {
  readonly directory: string;
  readonly descriptorPath: string;
  readonly lockPath: string;
  readonly socketPath: string;
}

interface ServiceTimeouts {
  readonly ready: number;
  readonly probe: number;
  readonly poll: number;
  readonly graceful: number;
  readonly term: number;
  readonly kill: number;
  readonly lock: number;
}

interface DescriptorSnapshot {
  readonly descriptor: DaemonServiceDescriptor;
  readonly file: FileIdentity;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
}

type DescriptorReadResult =
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly error: DaemonServiceFailure }
  | ({ readonly status: "valid" } & DescriptorSnapshot);

interface LifecycleLock {
  readonly handle: FileHandle;
  readonly file: FileIdentity;
}

interface LifecycleLockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly processStartId: string;
  readonly token: string;
}

type IdentityObservation =
  | { readonly status: "same" }
  | { readonly status: "missing" }
  | { readonly status: "different" }
  | { readonly status: "inaccessible"; readonly error?: unknown };

type SocketCleanupResult = "absent" | "removed" | "live" | "unsafe" | "unknown";

export class DaemonServiceError extends Error {
  override readonly name = "DaemonServiceError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(boundedRedactedText(message, MAX_ERROR_LENGTH));
  }
}

/**
 * Serialized lifecycle manager for one detached daemon host process.
 *
 * The manager owns only process identity, readiness, and shutdown. It neither
 * opens Run state nor writes a Ledger. Process and control operations are
 * injected so the composition root can bind the existing DaemonHost later.
 */
export class DaemonServiceManager {
  readonly stateDirectory: string;
  readonly descriptorPath: string;
  readonly socketPath: string;

  readonly #location: ServiceLocation;
  readonly #executable: string;
  readonly #argv: readonly string[];
  readonly #controlProtocolVersion: number;
  readonly #dependencies: DaemonServiceDependencies;
  readonly #clock: Clock;
  readonly #monotonicNow: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #createInstanceToken: () => string;
  readonly #timeouts: ServiceTimeouts;
  #lastWallClockMs = Number.NEGATIVE_INFINITY;
  #startPromise: Promise<DaemonServiceStatus> | undefined;
  #stopPromise: Promise<DaemonServiceStatus> | undefined;
  #restartPromise: Promise<DaemonServiceStatus> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #childObservers = new Set<Promise<void>>();
  #closed = false;

  private constructor(
    location: ServiceLocation,
    options: DaemonServiceManagerOptions,
    argv: readonly string[],
    timeouts: ServiceTimeouts,
  ) {
    this.#location = location;
    this.stateDirectory = location.directory;
    this.descriptorPath = location.descriptorPath;
    this.socketPath = location.socketPath;
    this.#executable = options.executable;
    this.#argv = argv;
    this.#controlProtocolVersion = options.controlProtocolVersion;
    this.#dependencies = options.dependencies;
    this.#clock = options.clock ?? systemClock;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#sleep = options.sleep ?? delay;
    this.#createInstanceToken = options.createInstanceToken ?? randomUUID;
    this.#timeouts = timeouts;
  }

  static async open(options: DaemonServiceManagerOptions): Promise<DaemonServiceManager> {
    const validated = validateOptions(options);
    const prepared = await ensureRealDirectory(validated.stateDirectory);
    await chmod(prepared.path, 0o700);
    const directoryInfo = await lstat(prepared.path, { bigint: true });
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new DaemonServiceError("unsafe_state_directory", "daemon state directory is not private");
    }
    if ((Number(directoryInfo.mode) & 0o077) !== 0) {
      throw new DaemonServiceError("unsafe_state_directory", "daemon state directory permissions are not private");
    }
    const socketPath = join(prepared.path, basename(validated.socketPath));
    return new DaemonServiceManager({
      directory: prepared.path,
      descriptorPath: join(prepared.path, DESCRIPTOR_NAME),
      lockPath: join(prepared.path, LOCK_NAME),
      socketPath,
    }, options, validated.argv, validated.timeouts);
  }

  async status(): Promise<DaemonServiceStatus> {
    try {
      await this.#assertDirectoryIdentity();
      const read = await this.#readDescriptor();
      if (read.status === "absent") return this.#statusWithoutDescriptor();
      if (read.status === "invalid") return failedStatus(read.error);
      const mismatch = this.#descriptorConfigurationFailure(read.descriptor);
      if (mismatch !== undefined) return failedStatus(mismatch);
      return this.#freshStatus(read.descriptor);
    } catch (error: unknown) {
      return failedStatus(this.#failure("status_failed", error));
    }
  }

  start(): Promise<DaemonServiceStatus> {
    if (this.#closed) return Promise.resolve(failedStatus(failure("manager_closed", "service manager is closed")));
    if (this.#startPromise !== undefined) return this.#startPromise;
    const operation = this.#withLifecycleLock(() => this.#startLocked());
    this.#startPromise = operation;
    const clear = (): void => {
      if (this.#startPromise === operation) this.#startPromise = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  stop(): Promise<DaemonServiceStatus> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const operation = this.#withLifecycleLock(() => this.#stopLocked());
    this.#stopPromise = operation;
    const clear = (): void => {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  restart(): Promise<DaemonServiceStatus> {
    if (this.#closed) return Promise.resolve(failedStatus(failure("manager_closed", "service manager is closed")));
    if (this.#restartPromise !== undefined) return this.#restartPromise;
    const operation = this.#withLifecycleLock(async () => {
      const stopped = await this.#stopLocked();
      if (stopped.state === "failed") return stopped;
      return this.#startLocked();
    });
    this.#restartPromise = operation;
    const clear = (): void => {
      if (this.#restartPromise === operation) this.#restartPromise = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const pendingStarts: Promise<DaemonServiceStatus>[] = [];
    if (this.#startPromise !== undefined) pendingStarts.push(this.#startPromise);
    if (this.#restartPromise !== undefined) pendingStarts.push(this.#restartPromise);
    const operation = (async () => {
      let stopError: unknown;
      try {
        await this.stop();
      } catch (error: unknown) {
        stopError = error;
      }
      // A start/restart may already be waiting for the lifecycle lock. Wait
      // for it to observe the closed state before completing close().
      await Promise.allSettled(pendingStarts);
      if (stopError !== undefined) throw stopError;
      if (this.#childObservers.size > 0) {
        await withTimeout(
          Promise.allSettled([...this.#childObservers]),
          Math.min(1_000, this.#timeouts.kill + this.#timeouts.poll),
          "child observer drain timed out",
        ).catch(() => undefined);
      }
    })();
    this.#closePromise = operation;
    return operation;
  }

  async #startLocked(): Promise<DaemonServiceStatus> {
    // A start may have queued for the lifecycle lock before close() marked
    // this manager closed. Re-check under the lock so it cannot spawn after
    // close has begun.
    if (this.#closed) {
      return failedStatus(failure("manager_closed", "service manager is closed"));
    }
    try {
      await this.#assertDirectoryIdentity();
      const existing = await this.#readDescriptor();
      if (existing.status === "invalid") return failedStatus(existing.error);
      if (existing.status === "valid") {
        const mismatch = this.#descriptorConfigurationFailure(existing.descriptor);
        if (mismatch !== undefined) return failedStatus(mismatch);
        if (existing.descriptor.state === "failed") {
          const observed = await this.#observeIdentity(existing.descriptor);
          if (observed.status === "same" || observed.status === "inaccessible") {
            return descriptorStatus(existing.descriptor);
          }
          const cleaned = await this.#cleanupStale(existing);
          if (cleaned !== undefined) return cleaned;
        } else {
          const observed = await this.#observeIdentity(existing.descriptor);
          if (observed.status === "same") {
            if (existing.descriptor.state === "draining") {
              return descriptorStatus(existing.descriptor);
            }
            const ready = await this.#waitUntilReady(existing.descriptor);
            if (ready.state === "ready") {
              const next = transitionDescriptor(existing.descriptor, "ready", this.#timestamp());
              await this.#replaceDescriptor(next, existing.descriptor);
              return descriptorStatus(next);
            }
            const failed = transitionDescriptor(
              existing.descriptor,
              "failed",
              this.#timestamp(),
              ready.error,
            );
            await this.#replaceDescriptor(failed, existing.descriptor);
            await this.#terminateFailedStart(failed);
            return descriptorStatus(failed);
          }
          if (observed.status === "inaccessible") {
            return failedStatus(this.#failure("identity_unverifiable", observed.error));
          }
          const cleaned = await this.#cleanupStale(existing);
          if (cleaned !== undefined) return cleaned;
        }
      }

      const socketFailure = await this.#requireVacantSocket();
      if (socketFailure !== undefined) return failedStatus(socketFailure);

      const instanceToken = validateOpaqueIdentity(
        this.#createInstanceToken(),
        "instance token generator returned an invalid identity",
      );
      let child: DaemonServiceSpawnResult;
      try {
        child = await this.#dependencies.spawn({
          executable: this.#executable,
          argv: [...this.#argv],
          detached: true,
          descriptorPath: this.descriptorPath,
          socketPath: this.socketPath,
          instanceToken,
          controlProtocolVersion: this.#controlProtocolVersion,
        });
      } catch (error: unknown) {
        return failedStatus(this.#failure("spawn_failed", error, [instanceToken]));
      }
      if (!isPositiveSafeInteger(child?.pid) || !(child.exited instanceof Promise)) {
        if (isPositiveSafeInteger(child?.pid)) {
          const observed = await this.#inspectProcess(child.pid);
          if (observed.status === "running") {
            await this.#terminateIdentityQuietly({
              pid: child.pid,
              processStartId: observed.processStartId,
              instanceToken,
            });
          }
        }
        return failedStatus(failure("spawn_failed", "spawn adapter returned an invalid child handle"));
      }

      const processIdentity = await this.#waitForProcessIdentity(child.pid);
      if (processIdentity.status !== "running") {
        return failedStatus(this.#failure(
          processIdentity.status === "inaccessible" ? "identity_unverifiable" : "child_exited",
          processIdentity.status === "inaccessible" ? processIdentity.error : "child exited before identity publication",
          [instanceToken],
        ));
      }
      const processStartId = validateProcessStartIdentity(
        processIdentity.processStartId,
        "process inspector returned an invalid start identity",
      );
      let descriptor: DaemonServiceDescriptor;
      try {
        const now = this.#timestamp();
        descriptor = {
          version: DAEMON_SERVICE_DESCRIPTOR_VERSION,
          probeVersion: DAEMON_SERVICE_PROBE_VERSION,
          state: "starting",
          pid: child.pid,
          processStartId,
          instanceToken,
          controlProtocolVersion: this.#controlProtocolVersion,
          socketPath: this.socketPath,
          startedAt: now,
          updatedAt: now,
        };
      } catch (error: unknown) {
        await this.#terminateIdentityQuietly({ pid: child.pid, processStartId, instanceToken });
        return failedStatus(this.#failure("descriptor_publish_failed", error, [instanceToken]));
      }
      try {
        await this.#createDescriptor(descriptor);
      } catch (error: unknown) {
        await this.#terminateUnpublishedChild(descriptor);
        return failedStatus(this.#failure("descriptor_publish_failed", error, [instanceToken]));
      }
      this.#observeChildExit(descriptor, child.exited);

      const ready = await this.#waitUntilReady(descriptor);
      if (ready.state === "ready") {
        const next = transitionDescriptor(descriptor, "ready", this.#timestamp());
        await this.#replaceDescriptor(next, descriptor);
        return descriptorStatus(next);
      }
      const failed = transitionDescriptor(
        descriptor,
        "failed",
        this.#timestamp(),
        ready.error,
      );
      await this.#replaceDescriptor(failed, descriptor);
      await this.#terminateFailedStart(failed);
      return descriptorStatus(failed);
    } catch (error: unknown) {
      return failedStatus(this.#failure("start_failed", error));
    }
  }

  async #stopLocked(): Promise<DaemonServiceStatus> {
    try {
      await this.#assertDirectoryIdentity();
      const read = await this.#readDescriptor();
      if (read.status === "absent") return this.#statusWithoutDescriptor();
      if (read.status === "invalid") return failedStatus(read.error);
      const mismatch = this.#descriptorConfigurationFailure(read.descriptor);
      if (mismatch !== undefined) return failedStatus(mismatch);

      const identity = await this.#observeIdentity(read.descriptor);
      if (identity.status === "missing" || identity.status === "different") {
        const cleanupFailure = await this.#cleanupStale(read);
        return cleanupFailure ?? { state: "stopped" };
      }
      if (identity.status === "inaccessible") {
        return failedStatus(this.#failure("identity_unverifiable", identity.error));
      }

      let current = read.descriptor;
      if (current.state !== "draining") {
        const draining = transitionDescriptor(current, "draining", this.#timestamp());
        await this.#replaceDescriptor(draining, current);
        current = draining;
      }
      const processIdentity = descriptorIdentity(current);
      try {
        await withTimeout(
          this.#dependencies.requestShutdown({
            identity: processIdentity,
            probe: this.#probeRequest(current, this.#timeouts.graceful),
          }),
          this.#timeouts.graceful,
          "graceful shutdown timed out",
        );
      } catch {
        // A failed graceful request does not authorize a signal. Identity is
        // re-checked below before each escalation step.
      }

      let exit = await this.#waitForExit(current, this.#timeouts.graceful);
      if (exit.status === "inaccessible") {
        return this.#recordStopFailure(current, "identity_unverifiable", exit.error);
      }
      if (exit.status === "same") {
        const term = await this.#signalIfCurrent(current, "SIGTERM");
        if (term !== undefined) return term;
        exit = await this.#waitForExit(current, this.#timeouts.term);
      }
      if (exit.status === "inaccessible") {
        return this.#recordStopFailure(current, "identity_unverifiable", exit.error);
      }
      if (exit.status === "same") {
        const kill = await this.#signalIfCurrent(current, "SIGKILL");
        if (kill !== undefined) return kill;
        exit = await this.#waitForExit(current, this.#timeouts.kill);
      }
      if (exit.status === "same") {
        return this.#recordStopFailure(current, "shutdown_timeout", "daemon did not exit after bounded escalation");
      }
      if (exit.status === "inaccessible") {
        return this.#recordStopFailure(current, "identity_unverifiable", exit.error);
      }

      const latest = await this.#readDescriptor();
      if (latest.status === "valid" && sameDescriptorIdentity(latest.descriptor, current)) {
        const cleanupFailure = await this.#cleanupStale(latest);
        if (cleanupFailure !== undefined) return cleanupFailure;
      }
      return { state: "stopped" };
    } catch (error: unknown) {
      return failedStatus(this.#failure("stop_failed", error));
    }
  }

  async #freshStatus(descriptor: DaemonServiceDescriptor): Promise<DaemonServiceStatus> {
    if (descriptor.state === "failed") return descriptorStatus(descriptor);
    const process = await this.#observeIdentity(descriptor);
    if (process.status === "missing") return staleStatus(descriptor, "process_missing");
    if (process.status === "different") return staleStatus(descriptor, "process_identity_changed");
    if (process.status === "inaccessible") {
      return failedStatus(this.#failure("identity_unverifiable", process.error), descriptor.pid, descriptor.updatedAt);
    }
    if (descriptor.state === "ready") {
      const probe = await probeDaemonService({
        probe: this.#dependencies.probe,
        controlProtocolVersion: descriptor.controlProtocolVersion,
        instanceToken: descriptor.instanceToken,
        socketPath: descriptor.socketPath,
        timeoutMs: this.#timeouts.probe,
      });
      if (probe.status === "ready") {
        return probe.state === "draining"
          ? {
              state: "draining",
              pid: descriptor.pid,
              since: descriptor.updatedAt,
              controlProtocolVersion: descriptor.controlProtocolVersion,
            }
          : descriptorStatus(descriptor);
      }
      return failedStatus(
        failure(
          probe.status === "mismatch" ? "probe_mismatch" : "not_ready",
          probe.status === "mismatch" ? "daemon ready probe identity did not match" : "daemon ready probe failed",
        ),
        descriptor.pid,
        descriptor.updatedAt,
      );
    }
    return descriptorStatus(descriptor);
  }

  async #statusWithoutDescriptor(): Promise<DaemonServiceStatus> {
    const observed = await this.#inspectSocket();
    if (observed.status === "absent") return { state: "stopped" };
    if (observed.status === "other") {
      return failedStatus(failure("unsafe_socket_path", "daemon socket path is not a socket"));
    }
    if (observed.status === "inaccessible") {
      return failedStatus(this.#failure("socket_inspection_failed", observed.error));
    }
    return failedStatus(failure("unmanaged_socket", "daemon socket has no managed identity descriptor"));
  }

  async #waitUntilReady(
    descriptor: DaemonServiceDescriptor,
  ): Promise<{ readonly state: "ready" } | { readonly state: "failed"; readonly error: DaemonServiceFailure }> {
    const deadline = this.#deadline(this.#timeouts.ready);
    const maxAttempts = Math.ceil(this.#timeouts.ready / this.#timeouts.poll) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const identity = await this.#observeIdentity(descriptor);
      if (identity.status === "missing" || identity.status === "different") {
        return { state: "failed", error: failure("child_exited", "daemon exited before becoming ready") };
      }
      if (identity.status === "inaccessible") {
        return { state: "failed", error: this.#failure("identity_unverifiable", identity.error) };
      }
      const remaining = this.#remaining(deadline);
      if (remaining <= 0) break;
      const probe = await probeDaemonService({
        probe: this.#dependencies.probe,
        controlProtocolVersion: descriptor.controlProtocolVersion,
        instanceToken: descriptor.instanceToken,
        socketPath: descriptor.socketPath,
        timeoutMs: Math.max(1, Math.min(this.#timeouts.probe, Math.ceil(remaining))),
      });
      if (probe.status === "ready" && probe.state === "ready") return { state: "ready" };
      if (probe.status === "mismatch") {
        return { state: "failed", error: failure("probe_mismatch", "daemon ready probe identity did not match") };
      }
      if (probe.status === "error") {
        return { state: "failed", error: this.#failure("probe_failed", probe.error, [descriptor.instanceToken]) };
      }
      if (probe.status === "ready" && probe.state === "draining") {
        return { state: "failed", error: failure("unexpected_draining", "daemon entered draining before ready") };
      }
      const pause = Math.min(this.#timeouts.poll, Math.max(0, this.#remaining(deadline)));
      if (pause <= 0) break;
      await this.#sleep(pause);
    }
    return { state: "failed", error: failure("ready_timeout", "daemon did not become ready before the deadline") };
  }

  async #waitForProcessIdentity(pid: number): Promise<DaemonServiceProcessObservation> {
    const deadline = this.#deadline(this.#timeouts.ready);
    const maxAttempts = Math.ceil(this.#timeouts.ready / this.#timeouts.poll) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const observed = await this.#inspectProcess(pid);
      if (observed.status !== "missing") return observed;
      const pause = Math.min(this.#timeouts.poll, Math.max(0, this.#remaining(deadline)));
      if (pause <= 0) return observed;
      await this.#sleep(pause);
    }
    return { status: "missing" };
  }

  async #waitForExit(descriptor: DaemonServiceDescriptor, timeoutMs: number): Promise<IdentityObservation> {
    const deadline = this.#deadline(timeoutMs);
    const maxAttempts = Math.ceil(timeoutMs / this.#timeouts.poll) + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const observed = await this.#observeIdentity(descriptor);
      if (observed.status !== "same") return observed;
      const pause = Math.min(this.#timeouts.poll, Math.max(0, this.#remaining(deadline)));
      if (pause <= 0) return observed;
      await this.#sleep(pause);
    }
    return { status: "same" };
  }

  async #signalIfCurrent(
    descriptor: DaemonServiceDescriptor,
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<DaemonServiceStatus | undefined> {
    const observed = await this.#observeIdentity(descriptor);
    if (observed.status === "missing" || observed.status === "different") return undefined;
    if (observed.status === "inaccessible") {
      return this.#recordStopFailure(descriptor, "identity_unverifiable", observed.error);
    }
    try {
      await this.#dependencies.signal({ identity: descriptorIdentity(descriptor), signal });
      return undefined;
    } catch (error: unknown) {
      const after = await this.#observeIdentity(descriptor);
      if (after.status === "missing" || after.status === "different") return undefined;
      return this.#recordStopFailure(descriptor, "signal_failed", error);
    }
  }

  async #terminateFailedStart(descriptor: DaemonServiceDescriptor): Promise<void> {
    await this.#signalIfCurrentQuietly(descriptor, "SIGTERM");
    const afterTerm = await this.#waitForExit(descriptor, this.#timeouts.term);
    if (afterTerm.status !== "same") return;
    await this.#signalIfCurrentQuietly(descriptor, "SIGKILL");
    await this.#waitForExit(descriptor, this.#timeouts.kill);
  }

  async #terminateUnpublishedChild(descriptor: DaemonServiceDescriptor): Promise<void> {
    await this.#signalIfCurrentQuietly(descriptor, "SIGTERM");
    const afterTerm = await this.#waitForExit(descriptor, this.#timeouts.term);
    if (afterTerm.status !== "same") return;
    await this.#signalIfCurrentQuietly(descriptor, "SIGKILL");
  }

  async #terminateIdentityQuietly(identity: DaemonServiceProcessIdentity): Promise<void> {
    const observed = await this.#inspectProcess(identity.pid);
    if (observed.status !== "running" || observed.processStartId !== identity.processStartId) return;
    try {
      await this.#dependencies.signal({ identity, signal: "SIGTERM" });
    } catch {
      // Re-check below before escalating a failed TERM request.
    }
    const afterTerm = await this.#inspectProcess(identity.pid);
    if (afterTerm.status !== "running" || afterTerm.processStartId !== identity.processStartId) return;
    try {
      await this.#dependencies.signal({ identity, signal: "SIGKILL" });
    } catch {
      // The adapter failure is isolated; signaling never falls back to PID.
    }
  }

  async #signalIfCurrentQuietly(
    descriptor: DaemonServiceDescriptor,
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<boolean> {
    const observed = await this.#observeIdentity(descriptor);
    if (observed.status !== "same") return false;
    try {
      await this.#dependencies.signal({ identity: descriptorIdentity(descriptor), signal });
      return true;
    } catch {
      return false;
    }
  }

  async #recordStopFailure(
    descriptor: DaemonServiceDescriptor,
    code: string,
    error: unknown,
  ): Promise<DaemonServiceStatus> {
    const failed = transitionDescriptor(
      descriptor,
      "failed",
      this.#timestamp(),
      this.#failure(code, error, [descriptor.instanceToken]),
    );
    try {
      await this.#replaceDescriptor(failed, descriptor);
    } catch {
      // Preserve the original structured error if a replacement won the race.
    }
    return descriptorStatus(failed);
  }

  #observeChildExit(
    descriptor: DaemonServiceDescriptor,
    exited: Promise<DaemonServiceChildExit>,
  ): void {
    const observer = exited.then(
      (exit) => this.#recordChildExit(descriptor, childExitFailure(exit)),
      (error: unknown) => this.#recordChildExit(
        descriptor,
        this.#failure("child_observer_failed", error, [descriptor.instanceToken]),
      ),
    ).catch(() => undefined);
    this.#childObservers.add(observer);
    void observer.then(() => this.#childObservers.delete(observer));
  }

  async #recordChildExit(
    descriptor: DaemonServiceDescriptor,
    childFailure: DaemonServiceFailure,
  ): Promise<void> {
    const beforeLock = await this.#readDescriptor();
    if (
      beforeLock.status !== "valid"
      || !sameDescriptorIdentity(beforeLock.descriptor, descriptor)
      || beforeLock.descriptor.state === "failed"
      || beforeLock.descriptor.state === "draining"
    ) {
      return;
    }
    await this.#withLifecycleLock(async () => {
      const current = await this.#readDescriptor();
      if (
        current.status !== "valid"
        || !sameDescriptorIdentity(current.descriptor, descriptor)
        || current.descriptor.state === "failed"
        || current.descriptor.state === "draining"
      ) {
        return;
      }
      const failed = transitionDescriptor(
        current.descriptor,
        "failed",
        this.#timestamp(),
        childFailure,
      );
      await this.#replaceDescriptor(failed, current.descriptor);
    }).catch(() => undefined);
  }

  async #cleanupStale(snapshot: DescriptorSnapshot): Promise<DaemonServiceStatus | undefined> {
    const socket = await this.#cleanupSocket(snapshot.descriptor);
    if (socket === "live") {
      return failedStatus(failure("live_replacement", "daemon socket belongs to a live replacement"));
    }
    if (socket === "unsafe") {
      return failedStatus(failure("unsafe_socket_path", "daemon socket path is not a socket"));
    }
    if (socket === "unknown") {
      return failedStatus(failure("socket_liveness_unknown", "daemon socket liveness could not be verified"));
    }
    const removed = await this.#deleteDescriptorIfMatches(snapshot);
    if (!removed) {
      return failedStatus(failure("descriptor_replaced", "daemon identity descriptor changed during cleanup"));
    }
    return undefined;
  }

  async #cleanupSocket(descriptor: DaemonServiceDescriptor): Promise<SocketCleanupResult> {
    const initial = await this.#inspectSocket();
    if (initial.status === "absent") return "absent";
    if (initial.status === "other") return "unsafe";
    if (initial.status === "inaccessible") return "unknown";

    const probe = await probeDaemonService({
      probe: this.#dependencies.probe,
      controlProtocolVersion: descriptor.controlProtocolVersion,
      instanceToken: descriptor.instanceToken,
      socketPath: descriptor.socketPath,
      timeoutMs: this.#timeouts.probe,
    });
    if (probe.status !== "unavailable") {
      return probe.status === "error" ? "unknown" : "live";
    }
    const removed = await this.#removeSocket(initial.identity);
    if (removed === "removed" || removed === "absent") return removed;
    return removed === "replaced" ? "live" : "unknown";
  }

  async #requireVacantSocket(): Promise<DaemonServiceFailure | undefined> {
    const observed = await this.#inspectSocket();
    if (observed.status === "absent") return undefined;
    if (observed.status === "other") {
      return failure("unsafe_socket_path", "daemon socket path is not a socket");
    }
    if (observed.status === "socket") {
      return failure("unmanaged_socket", "daemon socket has no managed identity descriptor");
    }
    return this.#failure("socket_inspection_failed", observed.error);
  }

  async #inspectSocket(): Promise<DaemonServiceSocketObservation> {
    if (this.#dependencies.inspectSocket !== undefined) {
      try {
        const observed = await this.#dependencies.inspectSocket(this.socketPath);
        if (observed?.status === "absent" || observed?.status === "other") return observed;
        if (observed?.status === "inaccessible") return observed;
        if (observed?.status === "socket" && isSocketIdentity(observed.identity)) return observed;
        return { status: "inaccessible", error: "socket inspector returned an invalid result" };
      } catch (error: unknown) {
        return { status: "inaccessible", error };
      }
    }
    try {
      const info = await lstat(this.socketPath, { bigint: true });
      return info.isSymbolicLink() || !info.isSocket()
        ? { status: "other" }
        : { status: "socket", identity: socketIdentity(info) };
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "absent" }
        : { status: "inaccessible", error };
    }
  }

  async #removeSocket(
    expected: DaemonServiceSocketIdentity,
  ): Promise<"removed" | "absent" | "replaced" | "inaccessible"> {
    if (this.#dependencies.removeSocket !== undefined) {
      try {
        return await this.#dependencies.removeSocket(this.socketPath, expected);
      } catch {
        return "inaccessible";
      }
    }
    try {
      const current = await lstat(this.socketPath, { bigint: true });
      if (!current.isSocket() || !sameSocketIdentity(socketIdentity(current), expected)) {
        return "replaced";
      }
      await unlink(this.socketPath);
      await syncDirectory(this.stateDirectory);
      return "removed";
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "inaccessible";
    }
  }

  async #observeIdentity(descriptor: DaemonServiceDescriptor): Promise<IdentityObservation> {
    const observed = await this.#inspectProcess(descriptor.pid);
    if (observed.status === "missing") return { status: "missing" };
    if (observed.status === "inaccessible") return observed;
    return observed.processStartId === descriptor.processStartId
      ? { status: "same" }
      : { status: "different" };
  }

  async #inspectProcess(pid: number): Promise<DaemonServiceProcessObservation> {
    try {
      const observed = await this.#dependencies.inspectProcess(pid);
      if (observed?.status === "missing") return observed;
      if (observed?.status === "inaccessible") return observed;
      if (observed?.status === "running" && isProcessStartIdentity(observed.processStartId)) return observed;
      return { status: "inaccessible", error: "process inspector returned an invalid result" };
    } catch (error: unknown) {
      return { status: "inaccessible", error };
    }
  }

  async #readDescriptor(): Promise<DescriptorReadResult> {
    let handle: FileHandle;
    try {
      handle = await openNoFollow(this.descriptorPath, constants.O_RDONLY);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        return { status: "invalid", error: failure("unsafe_descriptor", "daemon identity descriptor is a symbolic link") };
      }
      return { status: "invalid", error: this.#failure("descriptor_unreadable", error) };
    }
    try {
      await assertRegularFile(handle, this.descriptorPath, true);
      const stats = await handle.stat({ bigint: true });
      if ((Number(stats.mode) & 0o077) !== 0) {
        return { status: "invalid", error: failure("unsafe_descriptor", "daemon identity descriptor permissions are not private") };
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_DESCRIPTOR_BYTES) {
        return { status: "invalid", error: failure("malformed_descriptor", "daemon identity descriptor has an invalid size") };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        return { status: "invalid", error: failure("malformed_descriptor", "daemon identity descriptor is not valid JSON") };
      }
      const descriptor = decodeDescriptor(parsed);
      if (descriptor === undefined) {
        return { status: "invalid", error: failure("malformed_descriptor", "daemon identity descriptor has an invalid shape") };
      }
      return { status: "valid", descriptor, file: fileIdentity(stats) };
    } catch (error: unknown) {
      return { status: "invalid", error: this.#failure("descriptor_unreadable", error) };
    } finally {
      await handle.close();
    }
  }

  async #createDescriptor(descriptor: DaemonServiceDescriptor): Promise<void> {
    const temporary = await this.#writeTemporaryDescriptor(descriptor);
    try {
      await link(temporary, this.descriptorPath);
      await unlink(temporary);
      await syncDirectory(this.stateDirectory);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #replaceDescriptor(
    descriptor: DaemonServiceDescriptor,
    expected: DaemonServiceDescriptor,
  ): Promise<void> {
    const current = await this.#readDescriptor();
    if (
      current.status !== "valid"
      || !sameDescriptorIdentity(current.descriptor, expected)
      || current.descriptor.state !== expected.state
    ) {
      throw new DaemonServiceError("descriptor_replaced", "daemon identity descriptor changed during update");
    }
    const temporary = await this.#writeTemporaryDescriptor(descriptor);
    try {
      const beforeRename = await lstat(this.descriptorPath, { bigint: true });
      if (!sameFileIdentity(current.file, fileIdentity(beforeRename))) {
        throw new DaemonServiceError("descriptor_replaced", "daemon identity descriptor changed during update");
      }
      await rename(temporary, this.descriptorPath);
      await syncDirectory(this.stateDirectory);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #writeTemporaryDescriptor(descriptor: DaemonServiceDescriptor): Promise<string> {
    const canonical = await assertRealDirectory(this.stateDirectory);
    if (canonical !== this.stateDirectory) {
      throw new DaemonServiceError("state_directory_replaced", "daemon state directory identity changed");
    }
    const bytes = Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8");
    if (bytes.byteLength > MAX_DESCRIPTOR_BYTES) {
      throw new DaemonServiceError("descriptor_too_large", "daemon identity descriptor exceeds the size limit");
    }
    const temporary = join(this.stateDirectory, `.${DESCRIPTOR_NAME}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await openNoFollow(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await writeAll(handle, bytes);
      await handle.sync();
    } catch (error: unknown) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return temporary;
  }

  async #deleteDescriptorIfMatches(snapshot: DescriptorSnapshot): Promise<boolean> {
    const current = await this.#readDescriptor();
    if (
      current.status !== "valid"
      || !sameDescriptorIdentity(current.descriptor, snapshot.descriptor)
      || !sameFileIdentity(current.file, snapshot.file)
    ) {
      return false;
    }
    const beforeDelete = await lstat(this.descriptorPath, { bigint: true });
    if (!sameFileIdentity(current.file, fileIdentity(beforeDelete))) return false;
    await unlink(this.descriptorPath);
    await syncDirectory(this.stateDirectory);
    return true;
  }

  #descriptorConfigurationFailure(
    descriptor: DaemonServiceDescriptor,
  ): DaemonServiceFailure | undefined {
    if (
      descriptor.socketPath !== this.socketPath
      || descriptor.controlProtocolVersion !== this.#controlProtocolVersion
      || descriptor.probeVersion !== DAEMON_SERVICE_PROBE_VERSION
    ) {
      return failure("descriptor_mismatch", "daemon identity descriptor does not match this service configuration");
    }
    return undefined;
  }

  async #withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    let lock: LifecycleLock | undefined;
    try {
      lock = await this.#acquireLifecycleLock();
      return await operation();
    } finally {
      if (lock !== undefined) await this.#releaseLifecycleLock(lock);
    }
  }

  async #acquireLifecycleLock(): Promise<LifecycleLock> {
    const self = await this.#inspectProcess(process.pid);
    if (self.status !== "running") {
      throw new DaemonServiceError("lock_identity_unavailable", "cannot establish lifecycle lock owner identity");
    }
    const owner: LifecycleLockOwner = {
      version: 1,
      pid: process.pid,
      processStartId: self.processStartId,
      token: randomUUID(),
    };
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
    const claimPath = join(
      this.stateDirectory,
      `.${LOCK_NAME}.${owner.pid}.${owner.token}.claim`,
    );
    const claim = await openNoFollow(
      claimPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await writeAll(claim, bytes);
      await claim.sync();
    } catch (error: unknown) {
      await claim.close();
      await unlink(claimPath).catch(() => undefined);
      throw error;
    }
    const deadline = this.#deadline(this.#timeouts.lock);
    const maxAttempts = Math.ceil(this.#timeouts.lock / this.#timeouts.poll) + 1;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          await link(claimPath, this.#location.lockPath);
          await unlink(claimPath);
          await syncDirectory(this.stateDirectory);
          const stats = await claim.stat({ bigint: true });
          return { handle: claim, file: fileIdentity(stats) };
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }

        const existing = await this.#readLifecycleLock();
        if (existing.status === "invalid") {
          throw new DaemonServiceError("invalid_lifecycle_lock", "daemon lifecycle lock cannot be trusted");
        }
        if (existing.status === "valid") {
          const observed = await this.#inspectProcess(existing.owner.pid);
          const stale = observed.status === "missing"
            || (observed.status === "running" && observed.processStartId !== existing.owner.processStartId);
          if (stale) {
            const current = await lstat(this.#location.lockPath, { bigint: true }).catch(() => undefined);
            if (current !== undefined && sameFileIdentity(existing.file, fileIdentity(current))) {
              await unlink(this.#location.lockPath);
              await syncDirectory(this.stateDirectory);
              continue;
            }
          }
        }
        const pause = Math.min(this.#timeouts.poll, Math.max(0, this.#remaining(deadline)));
        if (pause <= 0) break;
        await this.#sleep(pause);
      }
      throw new DaemonServiceError("lifecycle_busy", "daemon lifecycle operation is already in progress");
    } catch (error: unknown) {
      await claim.close();
      await unlink(claimPath).catch(() => undefined);
      throw error;
    }
  }

  async #readLifecycleLock(): Promise<
    | { readonly status: "absent" }
    | { readonly status: "invalid" }
    | { readonly status: "valid"; readonly owner: LifecycleLockOwner; readonly file: FileIdentity }
  > {
    let handle: FileHandle;
    try {
      handle = await openNoFollow(this.#location.lockPath, constants.O_RDONLY);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      return { status: "invalid" };
    }
    try {
      await assertRegularFile(handle, this.#location.lockPath);
      const stats = await handle.stat({ bigint: true });
      // nlink=2 is the atomic hard-link publication window before the owner
      // removes its private claim name. More links cannot be manager-created.
      if ((Number(stats.mode) & 0o077) !== 0 || stats.nlink > 2n) {
        return { status: "invalid" };
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_DESCRIPTOR_BYTES) return { status: "invalid" };
      const owner = decodeLockOwner(JSON.parse(bytes.toString("utf8")));
      return owner === undefined
        ? { status: "invalid" }
        : { status: "valid", owner, file: fileIdentity(stats) };
    } catch {
      return { status: "invalid" };
    } finally {
      await handle.close();
    }
  }

  async #releaseLifecycleLock(lock: LifecycleLock): Promise<void> {
    try {
      const current = await lstat(this.#location.lockPath, { bigint: true }).catch(() => undefined);
      if (current !== undefined && sameFileIdentity(lock.file, fileIdentity(current))) {
        await unlink(this.#location.lockPath);
        await syncDirectory(this.stateDirectory);
      }
    } finally {
      await lock.handle.close();
    }
  }

  async #assertDirectoryIdentity(): Promise<void> {
    const current = await assertRealDirectory(this.stateDirectory);
    if (current !== this.stateDirectory) {
      throw new DaemonServiceError("state_directory_replaced", "daemon state directory identity changed");
    }
    const stats = await lstat(current, { bigint: true });
    if ((Number(stats.mode) & 0o077) !== 0) {
      throw new DaemonServiceError("unsafe_state_directory", "daemon state directory permissions are not private");
    }
  }

  #probeRequest(descriptor: DaemonServiceDescriptor, timeoutMs: number): DaemonServiceProbeRequest {
    return {
      version: DAEMON_SERVICE_PROBE_VERSION,
      controlProtocolVersion: descriptor.controlProtocolVersion,
      instanceToken: descriptor.instanceToken,
      socketPath: descriptor.socketPath,
      timeoutMs,
    };
  }

  #failure(code: string, error: unknown, secrets: readonly string[] = []): DaemonServiceFailure {
    let message = error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "daemon service operation failed";
    for (const secret of secrets) {
      if (secret.length > 0) message = message.replaceAll(secret, "[REDACTED]");
    }
    return failure(code, message);
  }

  #timestamp(): string {
    const raw = this.#clock.now().getTime();
    if (!Number.isFinite(raw)) {
      throw new DaemonServiceError("invalid_clock", "clock returned an invalid time");
    }
    this.#lastWallClockMs = Math.max(this.#lastWallClockMs, raw);
    return new Date(this.#lastWallClockMs).toISOString();
  }

  #deadline(timeoutMs: number): number {
    const now = this.#monotonicNow();
    if (!Number.isFinite(now)) return timeoutMs;
    return now + timeoutMs;
  }

  #remaining(deadline: number): number {
    const now = this.#monotonicNow();
    if (!Number.isFinite(now)) return 0;
    return Math.max(0, deadline - now);
  }
}

function validateOptions(options: DaemonServiceManagerOptions): {
  readonly stateDirectory: string;
  readonly socketPath: string;
  readonly argv: readonly string[];
  readonly timeouts: ServiceTimeouts;
} {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new DaemonServiceError("invalid_options", "service options must be an object");
  }
  const stateDirectory = absolutePath(options.stateDirectory, "stateDirectory");
  const socketPath = absolutePath(options.socketPath, "socketPath");
  if (dirname(socketPath) !== stateDirectory || basename(socketPath) === DESCRIPTOR_NAME || basename(socketPath) === LOCK_NAME) {
    throw new DaemonServiceError("invalid_options", "socketPath must be a distinct direct child of stateDirectory");
  }
  if (
    typeof options.executable !== "string"
    || options.executable.length === 0
    || options.executable.trim() !== options.executable
    || options.executable.includes("\0")
  ) {
    throw new DaemonServiceError("invalid_options", "executable must be an explicit path or program name without NUL");
  }
  const argv = options.argv ?? [];
  if (!Array.isArray(argv) || argv.length > 256 || argv.some((value) => (
    typeof value !== "string" || value.length > 16_384 || value.includes("\0")
  ))) {
    throw new DaemonServiceError("invalid_options", "argv must contain bounded strings without NUL");
  }
  if (!isPositiveSafeInteger(options.controlProtocolVersion)) {
    throw new DaemonServiceError("invalid_options", "controlProtocolVersion must be a positive safe integer");
  }
  const dependencies = options.dependencies;
  if (
    dependencies === null
    || typeof dependencies !== "object"
    || typeof dependencies.spawn !== "function"
    || typeof dependencies.inspectProcess !== "function"
    || typeof dependencies.probe !== "function"
    || typeof dependencies.requestShutdown !== "function"
    || typeof dependencies.signal !== "function"
    || (dependencies.inspectSocket !== undefined && typeof dependencies.inspectSocket !== "function")
    || (dependencies.removeSocket !== undefined && typeof dependencies.removeSocket !== "function")
  ) {
    throw new DaemonServiceError("invalid_options", "all daemon service dependencies must be provided");
  }
  if (options.clock !== undefined && typeof options.clock.now !== "function") {
    throw new DaemonServiceError("invalid_options", "clock must provide now()");
  }
  if (options.monotonicNow !== undefined && typeof options.monotonicNow !== "function") {
    throw new DaemonServiceError("invalid_options", "monotonicNow must be a function");
  }
  if (options.sleep !== undefined && typeof options.sleep !== "function") {
    throw new DaemonServiceError("invalid_options", "sleep must be a function");
  }
  if (options.createInstanceToken !== undefined && typeof options.createInstanceToken !== "function") {
    throw new DaemonServiceError("invalid_options", "createInstanceToken must be a function");
  }
  return {
    stateDirectory,
    socketPath,
    argv: [...argv],
    timeouts: {
      ready: timeout(options.readyTimeoutMs, "readyTimeoutMs", DEFAULT_READY_TIMEOUT_MS),
      probe: timeout(options.probeTimeoutMs, "probeTimeoutMs", DEFAULT_PROBE_TIMEOUT_MS),
      poll: timeout(options.pollIntervalMs, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS),
      graceful: timeout(options.gracefulTimeoutMs, "gracefulTimeoutMs", DEFAULT_GRACEFUL_TIMEOUT_MS),
      term: timeout(options.termTimeoutMs, "termTimeoutMs", DEFAULT_TERM_TIMEOUT_MS),
      kill: timeout(options.killTimeoutMs, "killTimeoutMs", DEFAULT_KILL_TIMEOUT_MS),
      lock: timeout(options.lockTimeoutMs, "lockTimeoutMs", DEFAULT_LOCK_TIMEOUT_MS),
    },
  };
}

function decodeDescriptor(value: unknown): DaemonServiceDescriptor | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const baseKeys = [
    "version",
    "probeVersion",
    "state",
    "pid",
    "processStartId",
    "instanceToken",
    "controlProtocolVersion",
    "socketPath",
    "startedAt",
    "updatedAt",
  ];
  const keys = record.state === "failed" ? [...baseKeys, "failure"] : baseKeys;
  if (!hasOnlyKeys(record, keys)) return undefined;
  if (
    record.version !== DAEMON_SERVICE_DESCRIPTOR_VERSION
    || record.probeVersion !== DAEMON_SERVICE_PROBE_VERSION
    || (record.state !== "starting" && record.state !== "ready" && record.state !== "draining" && record.state !== "failed")
    || !isPositiveSafeInteger(record.pid)
    || !isProcessStartIdentity(record.processStartId)
    || !isOpaqueIdentity(record.instanceToken)
    || !isPositiveSafeInteger(record.controlProtocolVersion)
    || typeof record.socketPath !== "string"
    || !isAbsolute(record.socketPath)
    || record.socketPath.includes("\0")
    || !isIsoDate(record.startedAt)
    || !isIsoDate(record.updatedAt)
  ) {
    return undefined;
  }
  if (record.state === "failed" && !isFailure(record.failure)) return undefined;
  return record as unknown as DaemonServiceDescriptor;
}

function decodeLockOwner(value: unknown): LifecycleLockOwner | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["version", "pid", "processStartId", "token"])
    || record.version !== 1
    || !isPositiveSafeInteger(record.pid)
    || !isProcessStartIdentity(record.processStartId)
    || !isOpaqueIdentity(record.token)
  ) {
    return undefined;
  }
  return record as unknown as LifecycleLockOwner;
}

function transitionDescriptor(
  descriptor: DaemonServiceDescriptor,
  state: DaemonServiceDescriptorState,
  updatedAt: string,
  error?: DaemonServiceFailure,
): DaemonServiceDescriptor {
  return {
    version: descriptor.version,
    probeVersion: descriptor.probeVersion,
    state,
    pid: descriptor.pid,
    processStartId: descriptor.processStartId,
    instanceToken: descriptor.instanceToken,
    controlProtocolVersion: descriptor.controlProtocolVersion,
    socketPath: descriptor.socketPath,
    startedAt: descriptor.startedAt,
    updatedAt,
    ...(state === "failed" ? { failure: error ?? failure("service_failed", "daemon service failed") } : {}),
  };
}

function descriptorStatus(descriptor: DaemonServiceDescriptor): DaemonServiceStatus {
  if (descriptor.state === "failed") {
    const stored = descriptor.failure ?? failure("service_failed", "daemon service failed");
    return failedStatus(
      failure(
        stored.code,
        stored.message.replaceAll(descriptor.instanceToken, "[REDACTED]"),
      ),
      descriptor.pid,
      descriptor.updatedAt,
    );
  }
  return {
    state: descriptor.state,
    pid: descriptor.pid,
    since: descriptor.updatedAt,
    controlProtocolVersion: descriptor.controlProtocolVersion,
  };
}

function staleStatus(
  descriptor: DaemonServiceDescriptor,
  reason: "process_missing" | "process_identity_changed",
): DaemonServiceStatus {
  return {
    state: "stale",
    pid: descriptor.pid,
    since: descriptor.updatedAt,
    reason,
  };
}

function failedStatus(
  error: DaemonServiceFailure,
  pid?: number,
  since?: string,
): DaemonServiceStatus {
  return {
    state: "failed",
    ...(pid === undefined ? {} : { pid }),
    ...(since === undefined ? {} : { since }),
    error,
  };
}

function failure(code: string, message: string): DaemonServiceFailure {
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "service_failed";
  return {
    code: safeCode,
    message: boundedRedactedText(
      message.replace(/[\u0000-\u001f\u007f]/g, " "),
      MAX_ERROR_LENGTH,
    ),
  };
}

function childExitFailure(exit: DaemonServiceChildExit): DaemonServiceFailure {
  if (
    exit === null
    || typeof exit !== "object"
    || (exit.code !== null && !Number.isSafeInteger(exit.code))
    || (exit.signal !== null && typeof exit.signal !== "string")
  ) {
    return failure("child_exit", "daemon child exited with an invalid receipt");
  }
  return failure(
    "child_exit",
    exit.signal === null
      ? `daemon child exited with code ${String(exit.code)}`
      : `daemon child exited after ${boundedRedactedText(exit.signal, 32)}`,
  );
}

function descriptorIdentity(descriptor: DaemonServiceDescriptor): DaemonServiceProcessIdentity {
  return {
    pid: descriptor.pid,
    processStartId: descriptor.processStartId,
    instanceToken: descriptor.instanceToken,
  };
}

function sameDescriptorIdentity(
  left: DaemonServiceDescriptor,
  right: DaemonServiceDescriptor,
): boolean {
  return left.pid === right.pid
    && left.processStartId === right.processStartId
    && left.instanceToken === right.instanceToken;
}

function isFailure(value: unknown): value is DaemonServiceFailure {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return hasOnlyKeys(record, ["code", "message"])
    && typeof record.code === "string"
    && /^[a-z][a-z0-9_]{0,63}$/.test(record.code)
    && typeof record.message === "string"
    && record.message.length <= MAX_ERROR_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(record.message);
}

function validateOpaqueIdentity(value: unknown, message: string): string {
  if (!isOpaqueIdentity(value)) throw new DaemonServiceError("invalid_identity", message);
  return value;
}

function validateProcessStartIdentity(value: unknown, message: string): string {
  if (!isProcessStartIdentity(value)) throw new DaemonServiceError("invalid_identity", message);
  return value;
}

function isOpaqueIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= MAX_IDENTITY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isProcessStartIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_IDENTITY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function timeout(value: number | undefined, name: string, fallback: number): number {
  const normalized = value ?? fallback;
  if (!isPositiveSafeInteger(normalized) || normalized > MAX_TIMEOUT_MS) {
    throw new DaemonServiceError("invalid_options", `${name} must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return normalized;
}

function absolutePath(value: string, name: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || !isAbsolute(value)
  ) {
    throw new DaemonServiceError("invalid_options", `${name} must be an absolute path without NUL`);
  }
  return resolve(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function fileIdentity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: Number(stats.mode) };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function socketIdentity(stats: BigIntStats): DaemonServiceSocketIdentity {
  return {
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    mode: Number(stats.mode),
  };
}

function isSocketIdentity(value: unknown): value is DaemonServiceSocketIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return hasOnlyKeys(record, ["device", "inode", "mode"])
    && typeof record.device === "string"
    && /^\d{1,32}$/.test(record.device)
    && typeof record.inode === "string"
    && /^\d{1,32}$/.test(record.inode)
    && Number.isSafeInteger(record.mode)
    && (record.mode as number) >= 0;
}

function sameSocketIdentity(
  left: DaemonServiceSocketIdentity,
  right: DaemonServiceSocketIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(bytes, written, bytes.byteLength - written, written);
    if (result.bytesWritten === 0) {
      throw new DaemonServiceError("write_failed", "daemon service file write made no progress");
    }
    written += result.bytesWritten;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DaemonServiceError("timeout", message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
