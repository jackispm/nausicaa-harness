import type { Readable, Writable } from "node:stream";

import type {
  DaemonWorkerFrame,
  DaemonWorkerTransport,
} from "./daemon-worker-protocol.js";
import {
  DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES,
  DaemonWorkerTransportError,
  decodeDaemonWorkerFrame,
  encodeDaemonWorkerFrame,
} from "./daemon-worker-protocol.js";

export interface DaemonWorkerStdioTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly maxFrameBytes?: number;
}
/** JSONL transport shared by a spawned worker and a worker bootstrap. */
export class DaemonWorkerStdioTransport implements DaemonWorkerTransport {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly maxFrameBytes: number;
  private readonly frameListeners = new Set<(frame: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private buffer = "";
  private closed = false;
  private pendingBytes = 0;

  constructor(options: DaemonWorkerStdioTransportOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("transport options must be an object");
    if (options.input === undefined || options.output === undefined) throw new TypeError("stdio streams are required");
    this.input = options.input;
    this.output = options.output;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_DAEMON_WORKER_MAX_FRAME_BYTES;
    this.input.on("data", (chunk: Buffer | string) => this.consume(chunk));
    this.input.on("end", () => this.finish());
    this.input.on("close", () => this.finish());
    this.input.on("error", (error: Error) => this.finish(error));
    this.output.on("error", (error: Error) => this.finish(error));
  }

  send(frame: DaemonWorkerFrame): Promise<void> {
    if (this.closed) return Promise.reject(new DaemonWorkerTransportError("closed", "worker stdio transport is closed"));
    const encoded = encodeDaemonWorkerFrame(frame, this.maxFrameBytes);
    this.pendingBytes += Buffer.byteLength(encoded);
    return new Promise<void>((resolve, reject) => {
      this.output.write(encoded, (error?: Error | null) => {
        this.pendingBytes -= Buffer.byteLength(encoded);
        if (error !== undefined && error !== null) reject(error);
        else resolve();
      });
    });
  }

  onFrame(listener: (frame: unknown) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.finish();
    this.input.destroy();
    if (this.output !== process.stdout && this.output !== process.stderr) this.output.destroy();
  }

  private consume(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes * 2) {
      this.finish(new DaemonWorkerTransportError("malformed", "worker frame buffer exceeds its byte limit"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const frame = decodeDaemonWorkerFrame(line, this.maxFrameBytes);
        for (const listener of this.frameListeners) listener(frame);
      } catch (error: unknown) {
        this.finish(error instanceof Error ? error : new Error("malformed worker frame"));
        return;
      }
    }
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.frameListeners.clear();
  }
}
