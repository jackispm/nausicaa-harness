import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exportSessionFile,
  MAX_SESSION_FILE_BYTES,
  parsePortableSession,
  readSessionImportFile,
  type SessionFileSource,
} from "../../src/cli/session-files.js";
import type { AppendEvent, ConversationMessage, EventType } from "../../src/domain/index.js";
import { MemoryLedger } from "../../src/ledger/index.js";
import { commitRunCheckpoint } from "../../src/runtime/recovery.js";
import { resolveRunPolicy } from "../../src/runtime/run-policy.js";
import {
  MESSAGE_MEDIA_TYPE,
  projectSessionTranscript,
  TOOL_ARGUMENTS_MEDIA_TYPE,
} from "../../src/runtime/session-artifacts.js";
import { readSessionName, writeSessionName } from "../../src/runtime/session-metadata.js";
import { MemoryContentAddressedStore } from "../../src/store/index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nausicaa-session-files-"));
  directories.push(directory);
  return directory;
}

async function source(withTool = false): Promise<SessionFileSource & { ledger: MemoryLedger }> {
  const ledger = new MemoryLedger();
  const store = new MemoryContentAddressedStore();
  const runId = "test-run";
  let sequence = 0;
  const append = <K extends EventType>(type: K, payload: AppendEvent<K>["payload"], turn = false) => ledger.append({
    runId, laneId: "main", ...(turn ? { turnId: "turn-1" } : {}), type, payload,
    correlationId: "test", idempotencyKey: `event-${++sequence}`,
  });
  const message = (value: ConversationMessage) => store.put(JSON.stringify(value), MESSAGE_MEDIA_TYPE);
  await append("run.created", {
    workspace: "/private/project", policy: resolveRunPolicy({ tetoEnabled: false }), mainModel: "old-provider/model",
  });
  await append("lane.registered", { kind: "main" });
  const userRef = await message({ role: "user", content: "<script>alert('private')</script>", createdAt: "2026-09-07T00:00:00Z" });
  await append("input.admitted", { inputId: "input-1", messageRef: userRef, delivery: "new-turn", sequence: 1 });
  await append("turn.started", {
    turnId: "turn-1",
    inputId: "input-1",
    ordinal: 1,
    boundary: {
      collaborationMode: "default",
      capabilities: { allowWrite: false, allowShell: false, allowNetwork: false },
    },
  }, true);
  await append("input.delivered", {
    inputId: "input-1",
    turnId: "turn-1",
    boundary: "turn-start",
    expectedRevision: 1,
    expectedMessageRef: userRef,
  }, true);
  await append("user.message", { inputId: "input-1", messageRef: userRef, kind: "initial" }, true);
  if (withTool) {
    const arguments_ = { path: "README.md" };
    const answer = await message({
      role: "assistant", content: "Reading the file", toolCalls: [{ id: "call-1", name: "read_file", arguments: arguments_ }],
      createdAt: "2026-09-07T00:00:01Z",
    });
    await append("assistant.message", { messageRef: answer }, true);
    const argumentsRef = await store.put(JSON.stringify(arguments_), TOOL_ARGUMENTS_MEDIA_TYPE);
    await append("tool.requested", { operationId: "op-1", toolCallId: "call-1", name: "read_file", argumentsRef }, true);
    const resultRef = await message({ role: "tool", toolCallId: "call-1", toolName: "read_file", content: "File contents", isError: false, createdAt: "2026-09-07T00:00:02Z" });
    await append("tool.succeeded", { operationId: "op-1", toolCallId: "call-1", name: "read_file", resultRef }, true);
  }
  const answerRef = await message({ role: "assistant", content: "Hello, world", toolCalls: [], createdAt: "2026-09-07T00:00:03Z" });
  await append("assistant.message", { messageRef: answerRef }, true);
  await append("turn.completed", { turnId: "turn-1", answerRef }, true);
  await commitRunCheckpoint(ledger, runId);
  return { runId, ledger, store, events: await ledger.read(), title: "A named session" };
}

describe("session file portability", () => {
  it("roundtrips completed Main conversation and tool artifacts without model or tool execution", async () => {
    const directory = await workspace();
    const original = await source(true);
    const exported = await exportSessionFile({ ...original, workspace: directory, path: "history.jsonl" });
    const imported = await readSessionImportFile({ workspace: directory, path: exported.path });
    expect(imported.title).toBe(original.title);
    expect(imported.runId).toBe(original.runId);
    expect(await projectSessionTranscript(imported.store, imported.events, imported.runId))
      .toEqual(await projectSessionTranscript(original.store, original.events, original.runId));
    expect(imported.events.at(-1)?.type).toBe("checkpoint.committed");
    expect(imported.events.find((event) => event.type === "run.created")?.payload.workspace).toBe(".");
    expect((await stat(exported.path)).mode & 0o777).toBe(0o600);
  });

  it("defaults to standalone escaped HTML and safe unique filenames, never overwrites", async () => {
    const directory = await workspace();
    const original = await source();
    original.title = "../<img src=https://example.com onerror=alert(1)>";
    const first = await exportSessionFile({ ...original, workspace: directory });
    const second = await exportSessionFile({ ...original, workspace: directory });
    expect(first.path).not.toBe(second.path);
    expect(first.path).toMatch(/session-test-run-[a-f0-9]{8}\.html$/u);
    const contents = await readFile(first.path, "utf8");
    expect(contents).toContain("&lt;script&gt;");
    expect(contents).toContain("&lt;img");
    expect(contents).not.toMatch(/<script|<img|<iframe|<a\s/iu);
    expect(contents).toContain("default-src 'none'");
    await expect(exportSessionFile({ ...original, workspace: directory, path: first.path })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(first.path, "utf8")).toBe(contents);
  });

  it("excludes non-conversation artifacts and auxiliary lanes", async () => {
    const directory = await workspace();
    const original = await source();
    await original.store.put("MY_API_KEY=do-not-export", "application/json");
    await original.ledger.append({
      runId: original.runId, laneId: "teto", turnId: "aux-turn", type: "turn.started",
      payload: {
        turnId: "aux-turn",
        inputId: "aux-input",
        ordinal: 1,
        boundary: {
          collaborationMode: "default",
          capabilities: { allowWrite: false, allowShell: false, allowNetwork: false },
        },
      },
      correlationId: "aux", idempotencyKey: "aux-start",
    });
    await original.ledger.append({
      runId: original.runId, laneId: "teto", turnId: "aux-turn", type: "assistant.message",
      payload: { messageRef: await original.store.put(JSON.stringify({ role: "assistant", content: "auxiliary-secret", toolCalls: [], createdAt: "2026-09-07T00:00:04Z" }), MESSAGE_MEDIA_TYPE) },
      correlationId: "aux", idempotencyKey: "aux",
    });
    await original.ledger.append({
      runId: original.runId, laneId: "teto", turnId: "aux-turn", type: "turn.completed",
      payload: { turnId: "aux-turn" },
      correlationId: "aux", idempotencyKey: "aux-complete",
    });
    original.events = await original.ledger.read();
    const exported = await exportSessionFile({ ...original, workspace: directory, path: "private.jsonl" });
    const contents = await readFile(exported.path, "utf8");
    expect(contents).not.toContain("/private/project");
    const imported = await parsePortableSession(contents);
    expect(imported.events.every((event) => event.laneId === "main")).toBe(true);
    expect(await projectSessionTranscript(imported.store, imported.events, imported.runId)).toHaveLength(2);
    const artifacts = contents.trimEnd().split("\n").map((line) => JSON.parse(line) as { type: string; data?: string });
    expect(artifacts.flatMap((record) => record.data ? [Buffer.from(record.data, "base64").toString()] : []).join("\n"))
      .not.toMatch(/MY_API_KEY|auxiliary-secret/u);
  });

  it("rejects truncated, modified and unsupported exports before touching session storage", async () => {
    const directory = await workspace();
    const exported = await exportSessionFile({ ...await source(true), workspace: directory, path: "history.jsonl" });
    const contents = await readFile(exported.path, "utf8");
    await expect(parsePortableSession(contents.trimEnd())).rejects.toThrow("truncated");
    await expect(parsePortableSession(contents.replace('"version":1', '"version":99'))).rejects.toThrow("Unsupported");
    await expect(parsePortableSession(contents.replace('"workspace":"."', '"workspace":"altered"'))).rejects.toThrow("hash");
    const lines = contents.trimEnd().split("\n");
    const artifactIndex = lines.findIndex((line) => JSON.parse(line).type === "artifact");
    const record = JSON.parse(lines[artifactIndex]!) as { data: string };
    record.data = Buffer.from("tampered").toString("base64");
    lines[artifactIndex] = JSON.stringify(record);
    await expect(parsePortableSession(`${lines.join("\n")}\n`)).rejects.toThrow(/length|hash/u);
    await expect(readSessionImportFile({ workspace: directory, path: "history.html" })).rejects.toThrow(".jsonl");
  });

  it("rejects unfinished operations and queued input rather than silently discarding them", async () => {
    const directory = await workspace();
    const original = await source();
    const argumentsRef = await original.store.put("{}", TOOL_ARGUMENTS_MEDIA_TYPE);
    await original.ledger.append({ runId: original.runId, laneId: "main", turnId: "turn-1", type: "tool.requested", payload: { operationId: "pending", toolCallId: "pending", name: "write_file", argumentsRef }, correlationId: "pending", idempotencyKey: "pending" });
    await expect(exportSessionFile({ ...original, events: await original.ledger.read(), workspace: directory, path: "bad.jsonl" })).rejects.toThrow("unresolved");
    await expect(stat(join(directory, "bad.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects links, special files and oversized imports", async () => {
    const directory = await workspace();
    const original = await source();
    const exported = await exportSessionFile({ ...original, workspace: directory, path: "history.jsonl" });
    const link = join(directory, "link.jsonl");
    await symlink(exported.path, link);
    await expect(readSessionImportFile({ workspace: directory, path: link })).rejects.toThrow(/symbolic-link/u);
    await expect(exportSessionFile({ ...original, workspace: directory, path: link })).rejects.toThrow(/symbolic-link/u);
    const huge = join(directory, "huge.jsonl");
    const handle = await open(huge, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.truncate(MAX_SESSION_FILE_BYTES + 1);
    await handle.close();
    await expect(readSessionImportFile({ workspace: directory, path: huge })).rejects.toThrow("64 MiB");
    await mkdir(join(directory, "directory.jsonl"));
    await expect(readSessionImportFile({ workspace: directory, path: "directory.jsonl" })).rejects.toThrow(/regular file/u);
  });
});

describe("session names", () => {
  it("stores and updates a name independently of immutable history", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "runs", "run-1"), { recursive: true });
    await writeFile(join(directory, "runs", "run-1", "ledger.jsonl"), "untouched\n");
    expect(await readSessionName(directory, "run-1")).toBeUndefined();
    expect(await writeSessionName(directory, "run-1", "  First name  ")).toBe("First name");
    expect(await readSessionName(directory, "run-1")).toBe("First name");
    await writeSessionName(directory, "run-1", "Second name");
    expect(await readSessionName(directory, "run-1")).toBe("Second name");
    expect(await readFile(join(directory, "runs", "run-1", "ledger.jsonl"), "utf8")).toBe("untouched\n");
    expect((await stat(join(directory, "runs", "run-1", "title.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe names, identities and metadata links", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "runs", "run-1"), { recursive: true });
    for (const name of ["", " ", "line\nline", "escape\u001b", "x".repeat(161)]) {
      await expect(writeSessionName(directory, "run-1", name)).rejects.toThrow();
    }
    await expect(writeSessionName(directory, "../escape", "name")).rejects.toThrow("Run id");
    const outside = join(directory, "outside.json");
    await writeFile(outside, "untouched");
    await symlink(outside, join(directory, "runs", "run-1", "title.json"));
    await expect(writeSessionName(directory, "run-1", "name")).rejects.toThrow("symbolic-link");
    await expect(readSessionName(directory, "run-1")).rejects.toThrow("symbolic-link");
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });
});
