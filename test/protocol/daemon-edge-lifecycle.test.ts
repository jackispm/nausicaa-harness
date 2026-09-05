import { describe, expect, it, vi } from "vitest";

import type { DaemonSessionFactory } from "../../src/runtime/index.js";
import {
  MemoryExecutionLeaseStore,
  openDaemonRuntime,
} from "../../src/runtime/index.js";

describe("daemon edge composition lifecycle", () => {
  it("closes the host edge composition once after daemon shutdown", async () => {
    const close = vi.fn(async () => undefined);
    const session = {
      resumeCurrent: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const createSession = vi.fn<DaemonSessionFactory>(async () => session);
    const runtime = await openDaemonRuntime({
      session: { workspace: "/workspace", dataDir: "/state", model: "scripted" },
      host: { ownerId: "edge-lifecycle", leaseStore: new MemoryExecutionLeaseStore() },
      createSession,
      closeEdgeComposition: close,
    });
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(createSession).not.toHaveBeenCalled();
  });
});
