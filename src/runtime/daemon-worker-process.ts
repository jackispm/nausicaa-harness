import { spawn, type ChildProcess } from "node:child_process";

import type { DaemonWorkerClientOptions, DaemonWorkerClientSnapshot } from "./daemon-worker-client.js";
import { DaemonWorkerClient } from "./daemon-worker-client.js";
import { DaemonWorkerStdioTransport } from "./daemon-worker-transport.js";
import type { DaemonWorkerTransport } from "./daemon-worker-protocol.js";
import type { DaemonWorkerDescriptorPublisher } from "./daemon-worker-protocol.js";

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
      await this.options.descriptorPublisher.publish({
        version: 1,
        runId: this.options.runId,
        workerId: this.options.workerId,
        leasePath: this.options.lease.leasePath,
        fencingToken: this.options.lease.fencingToken,
        instanceToken,
        publishedAt: new Date().toISOString(),
      });
      this.publishedInstanceToken = instanceToken;
    }
    return this.snapshot;
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      try {
        if (this.publishedInstanceToken !== undefined) {
          await this.options.descriptorPublisher?.clear?.(this.publishedInstanceToken);
          this.publishedInstanceToken = undefined;
        }
      } finally {
        if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
          const child = this.child;
          child.kill();
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
    return this.transport;
  }
}

export function spawnDaemonWorker(options: DaemonWorkerProcessOptions): DaemonWorkerProcess {
  return new DaemonWorkerProcess(options);
}
