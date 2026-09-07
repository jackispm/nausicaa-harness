import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { AnyEvent, AppendEvent, EventType } from "../domain/events.js";
import type { ArtifactRef } from "../domain/types.js";
import {
  assertNoSymlinkComponents,
  assertRegularFile,
  canonicalFilePath,
  openNoFollow,
  syncDirectory,
} from "../ledger/file-utils.js";
import { LedgerState, MemoryLedger, projectRun, validateEvent } from "../ledger/index.js";
import { commitRunCheckpoint, projectionChecksum } from "../runtime/recovery.js";
import { resolveRunPolicy } from "../runtime/run-policy.js";
import {
  projectPendingAdmissions,
  projectSessionTranscript,
  readConversationArtifact,
  readToolArgumentsFromStore,
} from "../runtime/session-artifacts.js";
import { normalizeSessionName } from "../runtime/session-metadata.js";
import {
  type ContentAddressedStore,
  MemoryContentAddressedStore,
  assertArtifactRef,
  verifyArtifact,
} from "../store/index.js";

export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_RECORDS = 100_000;
const PORTABLE_FORMAT = "nausicaa-session";
const HISTORY_TYPES = new Set<EventType>([
  "step.started", "step.completed", "step.failed", "turn.started", "turn.resumed",
  "turn.completed", "turn.failed", "turn.cancelled", "turn.waiting", "turn.interrupted",
  "user.message", "assistant.message", "tool.requested", "tool.admitted", "tool.started",
  "approval.requested", "approval.decided", "tool.succeeded", "tool.failed", "model.selected",
]);

export interface SessionFileSource {
  runId: string;
  events: readonly AnyEvent[];
  store: ContentAddressedStore;
  title?: string;
}

export interface PortableSessionSource extends SessionFileSource {
  checkpoint: { watermark: number; checksum: string };
}

export async function exportSessionFile(options: SessionFileSource & {
  workspace: string;
  path?: string;
}): Promise<{ path: string; format: "html" | "jsonl" }> {
  validateRunId(options.runId);
  const title = options.title === undefined ? undefined : normalizeSessionName(options.title);
  const requested = options.path ?? `session-${options.runId}-${randomUUID().slice(0, 8)}.html`;
  const extension = extname(requested).toLowerCase();
  if (extension !== ".html" && extension !== ".jsonl") {
    throw new TypeError("Session export path must end in .html or .jsonl");
  }
  const contents = extension === ".jsonl"
    ? await serializePortableSession({ ...options, ...(title === undefined ? {} : { title }) })
    : await renderSessionHtml({ ...options, ...(title === undefined ? {} : { title }) });
  assertSize(Buffer.byteLength(contents));
  const destination = await canonicalFilePath(resolve(options.workspace, requested));
  const handle = await openNoFollow(
    destination.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600,
  );
  try {
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(destination.parent);
  } catch (error: unknown) {
    await unlink(destination.path).catch(() => undefined);
    throw error;
  }
  return { path: destination.path, format: extension === ".jsonl" ? "jsonl" : "html" };
}

export async function readSessionImportFile(options: {
  workspace: string;
  path: string;
}): Promise<PortableSessionSource> {
  const path = resolve(options.workspace, options.path);
  if (extname(path).toLowerCase() !== ".jsonl") {
    throw new TypeError("Session import requires a Nausicaa .jsonl export");
  }
  await assertNoSymlinkComponents(path);
  const handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let contents: string;
  try {
    await assertRegularFile(handle, path);
    const size = (await handle.stat()).size;
    assertSize(size);
    // Bound the read itself as well as stat, in case the file grows concurrently.
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    assertSize(length);
    if (length !== size) throw new TypeError("Session file changed while it was being read");
    contents = new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
  return parsePortableSession(contents);
}

async function serializePortableSession(source: SessionFileSource): Promise<string> {
  validateSourceEvents(source.events, source.runId);
  assertSettled(source.events, source.runId);
  const created = source.events.find((event) => event.type === "run.created");
  if (created === undefined) throw new TypeError("Session has no run.created event");
  const ledger = new MemoryLedger();
  await ledger.append({
    runId: source.runId,
    laneId: "main",
    type: "run.created",
    payload: {
      workspace: ".",
      policy: resolveRunPolicy({ tetoEnabled: false, workerEnabled: false }),
      ...(created.payload.mainModel === undefined ? {} : { mainModel: created.payload.mainModel }),
    },
    occurredAt: created.occurredAt,
    correlationId: "portable:run",
    idempotencyKey: "portable:run",
  });
  await ledger.append({
    runId: source.runId, laneId: "main", type: "lane.registered", payload: { kind: "main" },
    correlationId: "portable:lane", idempotencyKey: "portable:lane",
  });
  for (const event of source.events) {
    if (event.laneId !== "main" || !HISTORY_TYPES.has(event.type)) continue;
    await ledger.append({
      runId: source.runId, laneId: "main", type: event.type, payload: event.payload,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      occurredAt: event.occurredAt,
      correlationId: `portable:${event.globalOffset}`,
      idempotencyKey: `portable:${event.globalOffset}`,
      visibility: "run",
    } as AppendEvent);
  }
  await commitRunCheckpoint(ledger, source.runId);
  const events = await ledger.read();
  await validateConversationArtifacts(events, source.store);
  const lines = [JSON.stringify({
    type: PORTABLE_FORMAT, version: 1, runId: source.runId,
    ...(source.title === undefined ? {} : { title: source.title }),
  })];
  let bytes = Buffer.byteLength(lines[0]!) + 1;
  const append = (record: unknown): void => {
    const line = JSON.stringify(record);
    bytes += Buffer.byteLength(line) + 1;
    assertSize(bytes);
    if (lines.length >= MAX_SESSION_RECORDS) throw new RangeError("Too many session records");
    lines.push(line);
  };
  for (const event of events) append({ type: "event", event });
  for (const ref of collectArtifactRefs(events)) {
    assertSize(ref.byteLength);
    const content = await source.store.get(ref);
    verifyArtifact(content, ref);
    append({ type: "artifact", ref, data: Buffer.from(content).toString("base64") });
  }
  await ledger.close();
  return `${lines.join("\n")}\n`;
}

export async function parsePortableSession(contents: string): Promise<PortableSessionSource> {
  assertSize(Buffer.byteLength(contents));
  if (!contents.endsWith("\n")) throw new TypeError("Session export is truncated");
  const lines = contents.trimEnd().split("\n");
  if (lines.length > MAX_SESSION_RECORDS) throw new RangeError("Too many session records");
  const header = parseRecord(lines.shift()!);
  if (header.type !== PORTABLE_FORMAT || header.version !== 1 || typeof header.runId !== "string") {
    throw new TypeError("Unsupported session format; use a Nausicaa JSONL export");
  }
  validateRunId(header.runId);
  const title = header.title === undefined ? undefined : normalizeSessionName(header.title as string);
  const events: AnyEvent[] = [];
  const store = new MemoryContentAddressedStore();
  const stored = new Set<string>();
  for (const line of lines) {
    const record = parseRecord(line);
    if (record.type === "event") {
      validateEvent(record.event);
      const event = record.event;
      if (event.laneId !== "main" || (!HISTORY_TYPES.has(event.type)
        && event.type !== "run.created" && event.type !== "lane.registered"
        && event.type !== "checkpoint.committed")) {
        throw new TypeError(`Non-portable session event: ${event.type}`);
      }
      if (event.type === "run.created" && event.payload.goal !== undefined) {
        throw new TypeError("Portable sessions must not contain active Goals");
      }
      events.push(event);
    } else if (record.type === "artifact") {
      if (!isArtifactRef(record.ref) || typeof record.data !== "string") {
        throw new TypeError("Invalid session artifact record");
      }
      const ref = record.ref;
      assertArtifactRef(ref);
      const key = artifactKey(ref);
      if (stored.has(key)) throw new TypeError("Duplicate session artifact");
      const bytes = Buffer.from(record.data, "base64");
      if (bytes.toString("base64") !== record.data) throw new TypeError("Invalid artifact base64 encoding");
      verifyArtifact(bytes, ref);
      await store.put(bytes, ref.mediaType);
      stored.add(key);
    } else {
      throw new TypeError("Unknown session record");
    }
  }
  validateSourceEvents(events, header.runId);
  const checkpoint = events.at(-1);
  if (checkpoint?.type !== "checkpoint.committed"
    || checkpoint.payload.watermark !== checkpoint.globalOffset - 1
    || projectionChecksum(events.slice(0, -1), header.runId) !== checkpoint.payload.checksum) {
    throw new TypeError("Session checkpoint checksum mismatch");
  }
  assertSettled(events, header.runId);
  const refs = collectArtifactRefs(events);
  if (refs.length !== stored.size) throw new TypeError("Session contains unreferenced artifacts");
  for (const ref of refs) await store.get(ref);
  await validateConversationArtifacts(events, store);
  return {
    runId: header.runId, events, store, checkpoint: { ...checkpoint.payload },
    ...(title === undefined ? {} : { title }),
  };
}

async function renderSessionHtml(source: SessionFileSource): Promise<string> {
  validateSourceEvents(source.events, source.runId);
  const transcript = await projectSessionTranscript(source.store, source.events, source.runId);
  const title = escapeHtml(source.title ?? `Session ${source.runId}`);
  const entries = transcript.map((entry) => {
    const label = entry.role === "tool" ? `${entry.toolName} (${entry.status})` : entry.role;
    const images = "imageTypes" in entry && entry.imageTypes?.length
      ? `<p>${escapeHtml(`Images: ${entry.imageTypes.join(", ")}`)}</p>` : "";
    return `<article><h2>${escapeHtml(label)}</h2><pre>${escapeHtml(entry.content)}</pre>${images}</article>`;
  });
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${title}</title><style>body{margin:0 auto;padding:24px;max-width:960px;font:16px/1.6 system-ui,sans-serif;color:#202124;background:#fff}h1{font-size:24px}h2{font-size:16px}article{border-top:1px solid #ddd;padding:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}p{color:#555}</style></head><body><h1>${title}</h1><p>${escapeHtml(source.runId)}</p>${entries.join("\n")}</body></html>\n`;
}

function validateSourceEvents(events: readonly AnyEvent[], runId: string): void {
  validateRunId(runId);
  if (events.length === 0 || events.length > MAX_SESSION_RECORDS) {
    throw new TypeError("Session event list is empty or too large");
  }
  if (events.some((event) => event.runId !== runId)) throw new TypeError("Session mixes Run identities");
  new LedgerState([...events]);
  if (events.filter((event) => event.type === "run.created").length !== 1
    || events[0]?.type !== "run.created") {
    throw new TypeError("Session must start with exactly one run.created event");
  }
}

function assertSettled(events: readonly AnyEvent[], runId: string): void {
  const projection = projectRun(events, runId);
  if (projection.activeTurnId !== undefined || Object.values(projection.turns)
    .some((turn) => turn.status === "waiting" || turn.status === "interrupted")
    || projectPendingAdmissions(events).length > 0) {
    throw new TypeError("Finish or recover pending Turns and queued input before exporting/importing");
  }
  const pending = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.requested") pending.add(event.payload.operationId);
    if (event.type === "tool.succeeded" || event.type === "tool.failed") pending.delete(event.payload.operationId);
  }
  if (pending.size > 0) throw new TypeError("Session has unresolved tool operations");
}

async function validateConversationArtifacts(events: readonly AnyEvent[], store: ContentAddressedStore): Promise<void> {
  const calls = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool.requested") {
      await readToolArgumentsFromStore(store, event.payload.argumentsRef);
    }
    if (event.type !== "user.message" && event.type !== "assistant.message"
      && event.type !== "tool.succeeded" && event.type !== "tool.failed") continue;
    const ref = "messageRef" in event.payload ? event.payload.messageRef : event.payload.resultRef;
    const message = await readConversationArtifact(store, ref);
    if (event.type === "user.message" && message.role !== "user") throw new TypeError("Invalid user message role");
    if (event.type === "assistant.message") {
      if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) throw new TypeError("Invalid assistant message");
      for (const call of message.toolCalls) {
        if (call === null || typeof call !== "object" || typeof call.id !== "string"
          || !call.id || typeof call.name !== "string" || !call.name
          || call.arguments === null || typeof call.arguments !== "object" || Array.isArray(call.arguments)
          || calls.has(call.id)) throw new TypeError("Invalid or duplicate assistant tool call");
        calls.set(call.id, call.name);
      }
    }
    if (event.type === "tool.succeeded" || event.type === "tool.failed") {
      if (message.role !== "tool" || message.toolCallId !== event.payload.toolCallId
        || message.toolName !== event.payload.name || typeof message.isError !== "boolean"
        || calls.get(message.toolCallId) !== message.toolName) throw new TypeError("Unpaired tool result");
      calls.delete(message.toolCallId);
    }
  }
  if (calls.size > 0) throw new TypeError("Session has assistant tool calls without results");
}

function collectArtifactRefs(events: readonly AnyEvent[]): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) throw new TypeError("Session value is too deeply nested");
    if (isArtifactRef(value)) {
      assertArtifactRef(value);
      refs.set(artifactKey(value), value);
    } else if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  };
  for (const event of events) visit(event.payload, 0);
  return [...refs.values()];
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<ArtifactRef>;
  return typeof ref.id === "string" && typeof ref.contentHash === "string"
    && typeof ref.mediaType === "string" && typeof ref.byteLength === "number";
}

function artifactKey(ref: ArtifactRef): string {
  return `${ref.contentHash}:${ref.mediaType}:${ref.byteLength}`;
}

function parseRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Session record must be an object");
  }
  return value as Record<string, unknown>;
}

function assertSize(bytes: number): void {
  if (bytes > MAX_SESSION_FILE_BYTES) throw new RangeError("Session file exceeds the 64 MiB limit");
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new TypeError("Invalid session Run id");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}
