import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  lstat,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

const STORE_VERSION = 1;
const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 20;
const MAX_PROVIDER_ID_BYTES = 128;
const MAX_CREDENTIAL_KEY_BYTES = 64 * 1024;

interface CredentialDocument {
  version: typeof STORE_VERSION;
  credentials: Record<string, Credential>;
}

export interface FileCredentialStoreOptions {
  /** Override the path in tests or an embedding; production defaults to ~/.nausicaa. */
  filePath?: string;
  /** Home directory used when filePath is omitted. */
  userHome?: string;
  /** Maximum time to wait for another process to finish a credential mutation. */
  lockTimeoutMs?: number;
}

export class CredentialStoreError extends Error {
  override readonly name = "CredentialStoreError";
}

/**
 * Small file-backed implementation of pi-ai's CredentialStore contract.
 * Credentials are deliberately kept apart from settings, Run state, and the
 * Ledger. Writes are serialized in-process and published with rename so a
 * reader observes either the old document or the complete new document.
 */
export class FileCredentialStore implements CredentialStore {
  readonly filePath: string;

  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly providerChains = new Map<string, Promise<void>>();

  constructor(options: FileCredentialStoreOptions = {}) {
    const filePath = options.filePath
      ?? join(options.userHome ?? homedir(), ".nausicaa", "credentials.json");
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) {
      throw new CredentialStoreError("Credential store lock timeout is invalid");
    }
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    assertProviderId(providerId);
    throwIfAborted(options?.signal);
    const document = await this.readDocument();
    throwIfAborted(options?.signal);
    const credential = document.credentials[providerId];
    return credential === undefined ? undefined : structuredClone(credential);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options?.signal);
    const document = await this.readDocument();
    throwIfAborted(options?.signal);
    return Object.entries(document.credentials)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    assertProviderId(providerId);
    const previous = this.providerChains.get(providerId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      throwIfAborted(options?.signal);
      return this.withFileLock(async () => {
        throwIfAborted(options?.signal);
        const document = await this.readDocument();
        const current = document.credentials[providerId];
        const next = await fn(current === undefined ? undefined : structuredClone(current));
        throwIfAborted(options?.signal);
        if (next === undefined) {
          return current === undefined ? undefined : structuredClone(current);
        }
        validateCredential(next);
        document.credentials[providerId] = structuredClone(next);
        await this.writeDocument(document);
        return structuredClone(next);
      }, options?.signal);
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.providerChains.set(providerId, tail);
    void tail.then(() => {
      if (this.providerChains.get(providerId) === tail) {
        this.providerChains.delete(providerId);
      }
    });
    return operation;
  }

  async delete(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<void> {
    assertProviderId(providerId);
    const previous = this.providerChains.get(providerId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      throwIfAborted(options?.signal);
      await this.withFileLock(async () => {
        throwIfAborted(options?.signal);
        const document = await this.readDocument();
        if (document.credentials[providerId] === undefined) return;
        delete document.credentials[providerId];
        await this.writeDocument(document);
      }, options?.signal);
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.providerChains.set(providerId, tail);
    void tail.then(() => {
      if (this.providerChains.get(providerId) === tail) {
        this.providerChains.delete(providerId);
      }
    });
    await operation;
  }

  private async readDocument(): Promise<CredentialDocument> {
    let source: string;
    try {
      await assertPrivateDirectory(dirname(this.filePath));
      const info = await lstat(this.filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new CredentialStoreError("Credential store is not a regular file");
      }
      assertCurrentUserOwner(info, "Credential store");
      if ((info.mode & 0o077) !== 0) await chmod(this.filePath, DEFAULT_FILE_MODE);
      source = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyDocument();
      }
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError("Cannot read credential store", { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error: unknown) {
      throw new CredentialStoreError("Credential store is not valid JSON", { cause: error });
    }
    return parseDocument(value);
  }

  private async writeDocument(document: CredentialDocument): Promise<void> {
    const parent = dirname(this.filePath);
    await ensurePrivateDirectory(parent);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        DEFAULT_FILE_MODE,
      );
      const encoded = `${JSON.stringify(document, null, 2)}\n`;
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, DEFAULT_FILE_MODE);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new CredentialStoreError("Cannot write credential store", { cause: error });
    }
  }

  private async withFileLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const parent = dirname(this.filePath);
    await ensurePrivateDirectory(parent);
    const deadline = Date.now() + this.lockTimeoutMs;
    let lock;
    while (lock === undefined) {
      throwIfAborted(signal);
      try {
        lock = await open(
          this.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          DEFAULT_FILE_MODE,
        );
        // A pre-existing symlink is handled as a busy lock, never followed.
        await lock.writeFile(`${process.pid}\n`, "utf8");
      } catch (error: unknown) {
        await lock?.close().catch(() => undefined);
        lock = undefined;
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw new CredentialStoreError("Cannot acquire credential store lock", { cause: error });
        }
        if (await this.lockIsStale()) {
          await unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new CredentialStoreError("Credential store is busy");
        }
        await delayWithAbort(LOCK_RETRY_MS, signal);
      }
    }

    try {
      return await operation();
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async lockIsStale(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath);
      return Date.now() - info.mtimeMs > STALE_LOCK_MS;
    } catch {
      return false;
    }
  }
}

export function createNausicaaCredentialStore(
  options: FileCredentialStoreOptions = {},
): FileCredentialStore {
  return new FileCredentialStore(options);
}

function emptyDocument(): CredentialDocument {
  return {
    version: STORE_VERSION,
    credentials: Object.create(null) as Record<string, Credential>,
  };
}

function parseDocument(value: unknown): CredentialDocument {
  if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.credentials)) {
    throw new CredentialStoreError("Credential store has an unsupported format");
  }
  const credentials: Record<string, Credential> = Object.create(null) as Record<string, Credential>;
  for (const [providerId, credential] of Object.entries(value.credentials)) {
    assertProviderId(providerId);
    validateCredential(credential);
    credentials[providerId] = structuredClone(credential);
  }
  return { version: STORE_VERSION, credentials };
}

function validateCredential(value: unknown): asserts value is Credential {
  if (!isRecord(value) || (value.type !== "api_key" && value.type !== "oauth")) {
    throw new CredentialStoreError("Credential store contains an invalid credential");
  }
  if (value.type === "api_key") {
    if (
      value.key !== undefined
      && (
        typeof value.key !== "string"
        || value.key.trim().length === 0
        || Buffer.byteLength(value.key, "utf8") > MAX_CREDENTIAL_KEY_BYTES
        || /[\u0000\r\n]/u.test(value.key)
      )
    ) {
      throw new CredentialStoreError("Credential store contains an invalid API key credential");
    }
    if (value.env !== undefined && !isRecordOfStrings(value.env)) {
      throw new CredentialStoreError("Credential store contains invalid provider environment values");
    }
    return;
  }
  if (
    typeof value.refresh !== "string"
    || value.refresh.length === 0
    || typeof value.access !== "string"
    || value.access.length === 0
    || typeof value.expires !== "number"
    || !Number.isSafeInteger(value.expires)
    || value.expires < 0
  ) {
    throw new CredentialStoreError("Credential store contains an invalid OAuth credential");
  }
}

function assertProviderId(value: string): void {
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ID_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new CredentialStoreError("Credential provider id is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}

async function delayWithAbort(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error: unknown) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: DEFAULT_DIRECTORY_MODE });
  } catch (error: unknown) {
    throw new CredentialStoreError("Cannot create credential store directory", { cause: error });
  }
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new CredentialStoreError("Cannot inspect credential store directory", { cause: error });
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CredentialStoreError("Credential store directory is not a private directory");
  }
  assertCurrentUserOwner(info, "Credential store directory");
  if ((info.mode & 0o077) !== 0) {
    try {
      await chmod(path, DEFAULT_DIRECTORY_MODE);
    } catch (error: unknown) {
      throw new CredentialStoreError("Cannot secure credential store directory", { cause: error });
    }
  }
}

function assertCurrentUserOwner(
  info: { uid?: number; mode: number },
  label: string,
): void {
  if (typeof process.getuid === "function" && info.uid !== undefined && info.uid !== process.getuid()) {
    throw new CredentialStoreError(`${label} is not owned by the current user`);
  }
}
