import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";

import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
} from "../domain/events.js";
import {
  assertRegularFile,
  canonicalFilePath,
  openNoFollow,
  syncDirectory,
} from "./file-utils.js";
import { stableJson } from "./hash.js";
import {
  LedgerClosedError,
  LedgerCorruptionError,
  LedgerError,
  LedgerState,
  LedgerWriterLockedError,
  type Ledger,
  type LedgerOptions,
  type ReadEventsOptions,
} from "./ledger.js";

interface LockOwner {
  version: 1;
  pid: number;
  hostname: string;
  token: string;
}

interface WriterLock {
  handle: FileHandle;
  path: string;
  parent: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readLockOwner(path: string): Promise<{
  owner: LockOwner;
  handle: FileHandle;
}> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new LedgerWriterLockedError(`Refusing symbolic-link writer lock: ${path}`);
    }
    throw error;
  }

  try {
    await assertRegularFile(handle, path);
    const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<LockOwner>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) < 1
      || typeof parsed.hostname !== "string"
      || parsed.hostname.length === 0
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
    ) {
      throw new LedgerWriterLockedError(`Invalid writer lock: ${path}`);
    }
    return { owner: parsed as LockOwner, handle };
  } catch (error) {
    await handle.close();
    if (error instanceof LedgerWriterLockedError) throw error;
    throw new LedgerWriterLockedError(`Invalid writer lock ${path}: ${String(error)}`);
  }
}

async function sameFile(path: string, handle: FileHandle): Promise<boolean> {
  try {
    const [pathInfo, handleInfo] = await Promise.all([lstat(path), handle.stat()]);
    return pathInfo.dev === handleInfo.dev && pathInfo.ino === handleInfo.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function acquireWriterLock(path: string, parent: string): Promise<WriterLock> {
  const owner: LockOwner = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
  };
  const claimPath = `${path}.${owner.pid}.${owner.token}.claim`;
  const claim = await openNoFollow(
    claimPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );

  try {
    await claim.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await claim.sync();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(claimPath, path);
        await unlink(claimPath);
        await syncDirectory(parent);
        return { handle: claim, path, parent };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let existing: Awaited<ReturnType<typeof readLockOwner>>;
      try {
        existing = await readLockOwner(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const localOwner = existing.owner.hostname === owner.hostname;
        if (!localOwner || isProcessAlive(existing.owner.pid)) {
          throw new LedgerWriterLockedError(
            `Ledger already has a writer (pid ${existing.owner.pid})`,
          );
        }

        if (await sameFile(path, existing.handle)) {
          await unlink(path);
          await syncDirectory(parent);
        }
      } finally {
        await existing.handle.close();
      }
    }

    throw new LedgerWriterLockedError("Could not acquire the ledger writer lock");
  } catch (error) {
    await claim.close();
    await unlink(claimPath).catch(() => undefined);
    throw error;
  }
}

async function releaseWriterLock(lock: WriterLock): Promise<void> {
  try {
    if (await sameFile(lock.path, lock.handle)) {
      await unlink(lock.path);
      await syncDirectory(lock.parent);
    }
  } finally {
    await lock.handle.close();
  }
}

interface ParsedJsonl {
  events: AnyEvent[];
  committedBytes: number;
}

function parseJsonl(contents: Buffer): ParsedJsonl {
  if (contents.byteLength === 0) {
    return { events: [], committedBytes: 0 };
  }

  const lastNewline = contents.lastIndexOf(0x0a);
  const committedBytes = lastNewline + 1;
  if (committedBytes === 0) {
    return { events: [], committedBytes: 0 };
  }

  const committed = contents.subarray(0, committedBytes).toString("utf8");
  const lines = committed.split("\n");
  lines.pop();

  const events = lines.map((line, index) => {
    if (line.trim().length === 0) {
      throw new LedgerCorruptionError(`Empty JSONL record at line ${index + 1}`);
    }
    try {
      return JSON.parse(line) as AnyEvent;
    } catch (error) {
      throw new LedgerCorruptionError(
        `Invalid JSONL record at line ${index + 1}: ${String(error)}`,
      );
    }
  });

  return { events, committedBytes };
}

export class JsonlLedger implements Ledger {
  readonly #handle: FileHandle;
  readonly #writerLock: WriterLock;
  readonly #state: LedgerState;
  #tail: Promise<void> = Promise.resolve();
  #accepting = true;
  #failure: Error | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(handle: FileHandle, writerLock: WriterLock, state: LedgerState) {
    this.#handle = handle;
    this.#writerLock = writerLock;
    this.#state = state;
  }

  static async open(path: string, options: LedgerOptions = {}): Promise<JsonlLedger> {
    const location = await canonicalFilePath(path);
    const lock = await acquireWriterLock(`${location.path}.lock`, location.parent);
    let handle: FileHandle | undefined;
    try {
      let created = false;
      try {
        const info = await lstat(location.path);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new LedgerError(`Ledger path is not a regular file: ${location.path}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        created = true;
      }

      handle = await openNoFollow(
        location.path,
        constants.O_RDWR | constants.O_CREAT | constants.O_APPEND,
        0o600,
      );
      await assertRegularFile(handle, location.path, true);
      if (created) await syncDirectory(location.parent);

      const contents = await handle.readFile();
      const parsed = parseJsonl(contents);
      const state = new LedgerState(parsed.events, options);

      if (parsed.committedBytes !== contents.byteLength) {
        await handle.truncate(parsed.committedBytes);
        await handle.sync();
      }
      return new JsonlLedger(handle, lock, state);
    } catch (error) {
      await handle?.close();
      await releaseWriterLock(lock);
      throw error;
    }
  }

  append<K extends EventType>(input: AppendEvent<K>): Promise<EventEnvelope<K>> {
    this.#assertAvailable();
    const frozenInput = structuredClone(input);
    const operation = this.#tail.then(async () => {
      this.#assertHealthy();
      const prepared = this.#state.prepare(frozenInput);
      if (prepared.duplicate) {
        return prepared.event;
      }

      const bytes = Buffer.from(`${stableJson(prepared.event)}\n`, "utf8");
      try {
        this.#state.preflight(prepared.event as AnyEvent);
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await this.#handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            null,
          );
          if (result.bytesWritten === 0) {
            throw new LedgerError("JSONL append made no progress");
          }
          written += result.bytesWritten;
        }
        await this.#handle.sync();
        this.#state.commit(prepared.event as AnyEvent);
        return prepared.event;
      } catch (error) {
        this.#failure = error instanceof Error ? error : new LedgerError(String(error));
        throw error;
      }
    });

    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async read(options: ReadEventsOptions = {}): Promise<AnyEvent[]> {
    this.#assertAvailable();
    await this.#tail;
    this.#assertHealthy();
    return this.#state.read(options);
  }

  async watermark(): Promise<number> {
    this.#assertAvailable();
    await this.#tail;
    this.#assertHealthy();
    return this.#state.watermark;
  }

  async flush(): Promise<void> {
    this.#assertAvailable();
    await this.#tail;
    this.#assertHealthy();
    await this.#handle.sync();
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#accepting = false;
    this.#closePromise = (async () => {
      await this.#tail;
      try {
        if (this.#failure === undefined) {
          await this.#handle.sync();
        }
      } finally {
        try {
          await this.#handle.close();
        } finally {
          await releaseWriterLock(this.#writerLock);
        }
      }
    })();
    return this.#closePromise;
  }

  #assertAvailable(): void {
    if (!this.#accepting) {
      throw new LedgerClosedError("Ledger is closed");
    }
    this.#assertHealthy();
  }

  #assertHealthy(): void {
    if (this.#failure !== undefined) {
      throw new LedgerError(`Ledger write state is uncertain: ${this.#failure.message}`);
    }
  }
}
