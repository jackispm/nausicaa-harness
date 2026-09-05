import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../../src/domain/ports.js";
import {
  LocalSessionRegistry,
  readLocalSessionRegistry,
} from "../../src/runtime/local-session-registry.js";

class MutableClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

const temporaryDirectories: string[] = [];
const registries: LocalSessionRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })),
  );
});

async function fixture(): Promise<{ dataDir: string; workspace: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "nausicaa-session-registry-"));
  temporaryDirectories.push(dataDir);
  const workspace = join(dataDir, "workspace");
  await mkdir(workspace);
  return { dataDir, workspace };
}

function createRegistry(
  dataDir: string,
  workspace: string,
  clock: MutableClock,
  sessionId?: string,
): LocalSessionRegistry {
  const registry = new LocalSessionRegistry({
    dataDir,
    workspace,
    clock,
    heartbeatMs: 60_000,
    staleMs: 10_000,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  registries.push(registry);
  return registry;
}

describe("LocalSessionRegistry", () => {
  it("assigns distinct ids by default and lists multiple sessions in one workspace", async () => {
    const { dataDir, workspace } = await fixture();
    const clock = new MutableClock(new Date("2026-09-05T12:00:00.000Z"));
    const first = createRegistry(dataDir, workspace, clock);
    const second = createRegistry(dataDir, workspace, clock);

    expect(first.sessionId).not.toBe(second.sessionId);
    await first.start({ state: "active", laneId: "main", runId: "run-a" });
    await second.start({ state: "idle", laneId: "main", runId: "run-b" });

    const observations = await readLocalSessionRegistry(dataDir, workspace, { clock });
    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.sessionId)).toEqual(
      expect.arrayContaining([first.sessionId, second.sessionId]),
    );
    expect(observations.map((entry) => entry.runId)).toEqual(
      expect.arrayContaining(["run-a", "run-b"]),
    );
  });

  it("filters records by workspace while retaining a session without a run id", async () => {
    const { dataDir, workspace } = await fixture();
    const otherWorkspace = join(dataDir, "other-workspace");
    await mkdir(otherWorkspace);
    const clock = new MutableClock(new Date("2026-09-05T12:00:00.000Z"));
    const current = createRegistry(dataDir, workspace, clock, "session-current");
    const other = createRegistry(dataDir, otherWorkspace, clock, "session-other");

    await current.start({ state: "waiting", laneId: "main" });
    await other.start({ state: "active", laneId: "main", runId: "other-run" });

    const currentRecords = await readLocalSessionRegistry(dataDir, workspace, { clock });
    expect(currentRecords).toHaveLength(1);
    expect(currentRecords[0]).toMatchObject({
      sessionId: "session-current",
      state: "waiting",
      live: true,
    });
    expect(currentRecords[0]).not.toHaveProperty("runId");

    const otherRecords = await readLocalSessionRegistry(dataDir, otherWorkspace, { clock });
    expect(otherRecords).toHaveLength(1);
    expect(otherRecords[0]).toMatchObject({
      sessionId: "session-other",
      runId: "other-run",
    });
  });

  it("matches a symlinked workspace to the canonical presence record", async () => {
    const { dataDir, workspace } = await fixture();
    const linkedWorkspace = join(dataDir, "workspace-link");
    await symlink(workspace, linkedWorkspace, "dir");
    const clock = new MutableClock(new Date("2026-09-05T12:00:00.000Z"));
    const registry = createRegistry(dataDir, workspace, clock, "session-symlink");

    await registry.start({ state: "active", runId: "run-symlink" });

    await expect(readLocalSessionRegistry(dataDir, linkedWorkspace, { clock })).resolves.toMatchObject([
      expect.objectContaining({ sessionId: "session-symlink", runId: "run-symlink", live: true }),
    ]);
  });

  it("updates lastSeen on heartbeat updates without changing startedAt", async () => {
    const { dataDir, workspace } = await fixture();
    const clock = new MutableClock(new Date("2026-09-05T12:00:00.000Z"));
    const registry = createRegistry(dataDir, workspace, clock, "session-heartbeat");

    await registry.start({ state: "active", activitySummary: "starting" });
    const initial = (await registry.list())[0]!;
    expect(initial.startedAt).toBe("2026-09-05T12:00:00.000Z");
    expect(initial.lastSeen).toBe("2026-09-05T12:00:00.000Z");

    clock.advance(1_500);
    await registry.update({ activitySummary: "still working" });
    const updated = (await registry.list())[0]!;
    expect(updated.startedAt).toBe(initial.startedAt);
    expect(updated.lastSeen).toBe("2026-09-05T12:00:01.500Z");
    expect(updated.activitySummary).toBe("still working");
    expect(updated.live).toBe(true);
  });

  it("projects an active session as offline after its heartbeat becomes stale", async () => {
    const { dataDir, workspace } = await fixture();
    const clock = new MutableClock(new Date("2026-09-05T12:00:00.000Z"));
    const registry = createRegistry(dataDir, workspace, clock, "session-stale");

    await registry.start({ state: "active" });
    clock.advance(10_001);

    const observations = await readLocalSessionRegistry(dataDir, workspace, {
      clock,
      staleMs: 10_000,
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sessionId: "session-stale",
      state: "offline",
      live: false,
    });
  });

  it("does not let a closed instance delete a newer record with the same session id", async () => {
    const { dataDir, workspace } = await fixture();
    const clock = new MutableClock(new Date("2026-09-05T12:00:00.000Z"));
    const first = createRegistry(dataDir, workspace, clock, "session-shared");
    const second = createRegistry(dataDir, workspace, clock, "session-shared");

    await first.start({ state: "active", runId: "run-first" });
    await second.start({ state: "active", runId: "run-second" });
    await first.close();

    const newer = await readLocalSessionRegistry(dataDir, workspace, { clock });
    expect(newer).toHaveLength(1);
    expect(newer[0]).toMatchObject({
      sessionId: "session-shared",
      runId: "run-second",
    });

    await second.close();
    await expect(readLocalSessionRegistry(dataDir, workspace, { clock })).resolves.toEqual([]);
  });

  it("ignores corrupt, oversized, and symbolic-link records", async () => {
    const { dataDir, workspace } = await fixture();
    const clock = new MutableClock(new Date("2026-09-05T12:00:00.000Z"));
    const valid = createRegistry(dataDir, workspace, clock, "session-valid");
    await valid.start({ state: "active", runId: "run-valid" });

    const sessionsDirectory = join(dataDir, "sessions");
    await writeFile(join(sessionsDirectory, "corrupt.json"), "{not-json", "utf8");
    await writeFile(
      join(sessionsDirectory, "oversized.json"),
      "x".repeat(32 * 1024 + 1),
      "utf8",
    );
    await symlink(
      join(sessionsDirectory, "session-valid.json"),
      join(sessionsDirectory, "linked.json"),
      "file",
    );

    const observations = await readLocalSessionRegistry(dataDir, workspace, { clock });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sessionId: "session-valid",
      runId: "run-valid",
      live: true,
    });
  });
});
