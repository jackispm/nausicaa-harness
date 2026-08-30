import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertNoSymlinkComponents } from "../ledger/file-utils.js";

import type {
  DaemonWorkerDescriptor,
  DaemonWorkerDescriptorPublisher,
} from "./daemon-worker-protocol.js";
import { DAEMON_WORKER_PROTOCOL_VERSION } from "./daemon-worker-protocol.js";

const MAX_DESCRIPTOR_BYTES = 16 * 1024;

/** Atomic, private descriptor publication for worker discovery/reattachment. */
export class FileDaemonWorkerDescriptorPublisher implements DaemonWorkerDescriptorPublisher {
  readonly path: string;

  constructor(path: string) {
    if (typeof path !== "string" || path.trim().length === 0 || path.includes("\0")) {
      throw new TypeError("descriptor path must be a non-empty path without NUL");
    }
    this.path = resolve(path);
  }

  async publish(descriptor: DaemonWorkerDescriptor): Promise<void> {
    validateDescriptor(descriptor);
    await assertNoSymlinkComponents(this.path);
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const encoded = `${JSON.stringify(descriptor)}\n`;
    if (Buffer.byteLength(encoded) > MAX_DESCRIPTOR_BYTES) throw new RangeError("worker descriptor exceeds its byte limit");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, encoded, { mode: 0o600, flag: "wx" });
    try {
      await assertNoSymlinkComponents(this.path);
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async clear(instanceToken: string): Promise<void> {
    if (typeof instanceToken !== "string" || instanceToken.length === 0) return;
    await assertNoSymlinkComponents(this.path);
    let current: DaemonWorkerDescriptor;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) return;
      current = JSON.parse(await readFile(this.path, "utf8")) as DaemonWorkerDescriptor;
    } catch {
      return;
    }
    if (current.instanceToken !== instanceToken) return;
    await unlink(this.path).catch(() => undefined);
  }
}

export async function readDaemonWorkerDescriptor(
  path: string,
): Promise<DaemonWorkerDescriptor | undefined> {
  const publisher = new FileDaemonWorkerDescriptorPublisher(path);
  await assertNoSymlinkComponents(publisher.path);
  try {
    const info = await lstat(publisher.path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const descriptor = JSON.parse(await readFile(publisher.path, "utf8")) as DaemonWorkerDescriptor;
    validateDescriptor(descriptor);
    return Object.freeze({ ...descriptor });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function validateDescriptor(value: DaemonWorkerDescriptor): void {
  if (value === null || typeof value !== "object") throw new TypeError("descriptor must be an object");
  if (value.version !== DAEMON_WORKER_PROTOCOL_VERSION) throw new TypeError("descriptor version is unsupported");
  for (const [field, candidate] of Object.entries({
    runId: value.runId,
    workerId: value.workerId,
    leasePath: value.leasePath,
    instanceToken: value.instanceToken,
    publishedAt: value.publishedAt,
  })) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) throw new TypeError(`descriptor ${field} is invalid`);
  }
  if (!Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) throw new TypeError("descriptor fencingToken is invalid");
  if (!Number.isFinite(Date.parse(value.publishedAt))) throw new TypeError("descriptor publishedAt is invalid");
}
