import { spawn, type ChildProcess } from "node:child_process";

import type { DaemonWorkerClientOptions, DaemonWorkerClientSnapshot } from "./daemon-worker-client.js";
import { DaemonWorkerClient } from "./daemon-worker-client.js";
import { DaemonWorkerStdioTransport } from "./daemon-worker-transport.js";
import type { DaemonWorkerTransport } from "./daemon-worker-protocol.js";
import type { DaemonWorkerDescriptorPublisher } from "./daemon-worker-protocol.js";

const DEFAULT_DESCRIPTOR_CLEAR_TIMEOUT_MS = 2_000;

export interface DaemonWorkerProcessOptions extends Omit<DaemonWorkerClientOptions, "transport" | "transportFactory"> {
  readonly command?: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: "pipe";
  readonly descriptorPublisher?: DaemonWorkerDescriptorPublisher;
}

export interface DaemonWorkerProcessSnapshot extends DaemonWorkerClientSnapshot {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

/** Spawn one worker process and expose its protocol client. */
export class DaemonWorkerProcess {
  readonly client: DaemonWorkerClient;
  private readonly options: DaemonWorkerProcessOptions;
  private child: ChildProcess | undefined;
  private transport: DaemonWorkerTransport | undefined;
  private exitCode: number | null | undefined;
  private signal: NodeJS.Signals | null | undefined;
  private publishedInstanceToken: string | undefined;
  private descriptorPublishPromise: Promise<void> | undefined;
  private descriptorPublicationSettled = false;
  private readonly descriptorCleanupTokens = new Set<string>();
  private closeRequested = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: DaemonWorkerProcessOptions) {
    this.options = { ...options, args: [...options.args] };
    this.client = new DaemonWorkerClient({
      ...options,
      transportFactory: {
        connect: async () => this.connect(),
      },
    });
  }

  get snapshot(): DaemonWorkerProcessSnapshot {
    return {
      ...this.client.snapshot,
      ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    };
  }

  async initialize(): Promise<DaemonWorkerProcessSnapshot> {
    await this.client.initialize();
    const instanceToken = this.client.snapshot.instanceToken;
    if (instanceToken !== undefined && this.options.descriptorPublisher !== undefined) {
      // Retain the token before publishing so a publisher that writes and then
      // rejects can still be asked to clear the possibly-visible descriptor.
      this.publishedInstanceToken = instanceToken;
      this.descriptorPublicationSettled = false;
      const publication = Promise.resolve().then(() => this.options.descriptorPublisher!.publish({
        version: 1,
        runId: this.options.runId,
        workerId: this.options.workerId,
        leasePath: this.options.lease.leasePath,
        fencingToken: this.options.lease.fencingToken,
        instanceToken,
        publishedAt: new Date().toISOString(),
      }));
      this.descriptorPublishPromise = publication;
      // Observe late completion even when a supervisor ready timeout wins the
      // race. A completed publication after close must be cleared by token.
      void publication.then(
        () => this.finishDescriptorPublication(publication, instanceToken),
        () => this.finishDescriptorPublication(publication, instanceToken),
      );
      try {
        await publication;
      } catch (error: unknown) {
        // A ready child without a discoverable descriptor is not a usable
        // worker. Tear down the client and process before exposing the error.
        // clear() is attempted even when publish failed midway, because an
        // atomic publisher may have completed publication before rejecting.
        await this.close().catch(() => undefined);
        throw error;
      }
    }
    return this.snapshot;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const operation = this.closeInternal();
    this.closePromise = operation;
    return operation;
  }

  private async closeInternal(): Promise<void> {
    this.closeRequested = true;
    try {
      await this.client.close();
    } finally {
      try {
        // A ready timeout may have raced with descriptor publication. Give the
        // publication a bounded chance to settle before clearing its token;
        // finishDescriptorPublication handles a late completion after timeout.
        if (this.descriptorPublishPromise !== undefined) {
          await waitBounded(
            this.descriptorPublishPromise,
            this.options.cancelGraceMs ?? DEFAULT_DESCRIPTOR_CLEAR_TIMEOUT_MS,
          );
        }
        if (this.publishedInstanceToken !== undefined && this.descriptorPublicationSettled) {
          await this.clearDescriptor(this.publishedInstanceToken);
        }
      } finally {
        if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
          const child = this.child;
          try {
            child.kill();
          } catch {
            // The child may have exited between the identity check and kill.
          }
          await Promise.race([
            new Promise<void>((resolve) => child.once("exit", () => resolve())),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1_000);
              timer.unref?.();
            }),
          ]);
        }
      }
    }
  }

  private finishDescriptorPublication(
    publication: Promise<void>,
    instanceToken: string,
  ): void {
    if (this.descriptorPublishPromise !== publication) return;
    this.descriptorPublicationSettled = true;
    this.descriptorPublishPromise = undefined;
    if (this.closeRequested) void this.clearDescriptor(instanceToken).catch(() => undefined);
  }

  private async clearDescriptor(instanceToken: string): Promise<void> {
    if (this.descriptorCleanupTokens.has(instanceToken)) return;
    this.descriptorCleanupTokens.add(instanceToken);
    try {
      // Descriptor cleanup is best-effort at process shutdown. A broken
      // filesystem/publisher must not keep the worker alive indefinitely.
      await waitBounded(
        Promise.resolve().then(() => this.options.descriptorPublisher?.clear?.(instanceToken)),
        this.options.cancelGraceMs ?? DEFAULT_DESCRIPTOR_CLEAR_TIMEOUT_MS,
      );
    } finally {
      if (this.publishedInstanceToken === instanceToken) this.publishedInstanceToken = undefined;
    }
  }

  private async connect(): Promise<DaemonWorkerTransport> {
    if (this.transport !== undefined) return this.transport;
    const child = spawn(this.options.command ?? process.execPath, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.once("exit", (code, signal) => {
      this.exitCode = code;
      this.signal = signal;
    });
    child.once("error", (error) => {
      child.stdout?.destroy(error);
      child.stdin?.destroy(error);
    });
    child.stderr?.on("data", () => undefined);
    if (child.stdin === null || child.stdout === null) {
      child.kill();
      throw new Error("worker process did not provide piped stdio");
    }
    this.transport = new DaemonWorkerStdioTransport({
      input: child.stdout,
      output: child.stdin,
      ...(this.options.maxFrameBytes === undefined ? {} : { maxFrameBytes: this.options.maxFrameBytes }),
    });
    const transport = this.transport;
    transport.onClose(() => {
      // A reconnect must spawn a fresh child after stdio has ended. Guard the
      // assignment so a late close from an older transport cannot clear a new
      // connection installed in the meantime.
      if (this.transport === transport) this.transport = undefined;
    });
    return transport;
  }
}

export function spawnDaemonWorker(options: DaemonWorkerProcessOptions): DaemonWorkerProcess {
  return new DaemonWorkerProcess(options);
}

async function waitBounded(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Keep a rejection handler attached after the timeout wins. A publisher
  // may finish asynchronously after close has returned; that late failure is
  // intentionally best-effort and must not become an unhandled rejection.
  const observed = promise.then(
    () => undefined,
    (error: unknown) => {
      if (timedOut) return;
      throw error;
    },
  );
  try {
    await Promise.race([
      observed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    timedOut = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
