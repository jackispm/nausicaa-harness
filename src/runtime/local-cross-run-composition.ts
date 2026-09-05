import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  CrossRunAuthorizationInput,
  CrossRunEndpoint,
  CrossRunResolvedTarget,
  CrossRunRoster,
  CrossRunRosterEntry,
  CrossRunSenderIdentity,
  CrossRunTargetAdmissionInput,
  CrossRunTargetSelector,
} from "../a2a/cross-run-contract.js";
import {
  CrossRunProtocolError,
  sameEndpoint,
  type CrossRunAuthorizer,
  type CrossRunTargetAdmission,
  type CrossRunTargetResolver,
  type CrossRunRosterResolver,
} from "../a2a/cross-run-contract.js";
import {
  LedgerCrossRunTargetAdmission,
  normalizeTargetAdmission,
} from "../a2a/cross-run-adapter.js";
import type { CrossRunEndpointStatus, CrossRunRelationship } from "../domain/types.js";
import type { Clock } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { JsonlLedger, LedgerWriterLockedError } from "../ledger/index.js";
import {
  listWorkspaceRuns,
  type WorkspaceRunStatus,
} from "./session-controller.js";
import { readLocalSessionRegistry } from "./local-session-registry.js";
import { enqueueLocalSessionMessage } from "./local-session-transport.js";
import type { CrossRunRuntimeComposition } from "./cross-run-runtime.js";

/** Stable local identity scope shared by CLI Awareness and local A2A. */
export const LOCAL_AGENT_WORKSPACE_ID = "local-workspace";
export const LOCAL_AGENT_SESSION_ID = "local-session";

const LOCAL_RELATIONSHIPS: readonly CrossRunRelationship[] = [
  "parent",
  "sibling",
  "child",
  "direct",
];
const LOCAL_VISIBILITIES = ["lane", "run", "user"] as const;
const DEFAULT_MAX_PRIORITY = 10;

export interface LocalCrossRunCompositionOptions {
  /** Canonical workspace used by listWorkspaceRuns for admission. */
  readonly workspace: string;
  /** Runtime data directory containing `runs/<runId>/ledger.jsonl`. */
  readonly dataDir: string;
  /** Host-owned identity scope; defaults match the CLI Awareness source. */
  readonly workspaceId?: string;
  /** Unique process/session identity; defaults to the legacy local scope. */
  readonly sessionId?: string;
  readonly clock?: Clock;
  /** Test seam; production generates an opaque, process-local proof. */
  readonly proofToken?: string;
}

/**
 * Compose the default CLI-local A2A boundary.
 *
 * This is deliberately a durable, same-workspace composition. It resolves
 * targets from verified Run metadata and admits messages through a target
 * Ledger, while leaving wake/scheduling to a daemon host when one is present.
 * It never opens a path supplied by the model and never exposes the proof
 * token through the AgentTool surface.
 */
export function createLocalCrossRunComposition(
  options: LocalCrossRunCompositionOptions,
): CrossRunRuntimeComposition {
  validateOptions(options);
  const workspace = resolve(options.workspace);
  const dataDir = resolve(options.dataDir);
  const workspaceId = options.workspaceId ?? LOCAL_AGENT_WORKSPACE_ID;
  const sessionId = options.sessionId ?? LOCAL_AGENT_SESSION_ID;
  const clock = options.clock ?? systemClock;
  const proofToken = options.proofToken ?? `local:${randomUUID()}`;

  const sender = (context: {
    readonly runId: string;
    readonly laneId: string;
    readonly sessionId?: string;
  }): CrossRunSenderIdentity => ({
    endpoint: {
      workspaceId,
      sessionId: context.sessionId ?? sessionId,
      runId: context.runId,
      laneId: context.laneId,
    },
    proof: {
      kind: "attach",
      authenticated: true,
      token: proofToken,
    },
    relationshipGrants: LOCAL_RELATIONSHIPS,
  });

  const resolver: CrossRunTargetResolver = {
    resolve: async (selector, source) => resolveLocalTarget(
      selector,
      source.endpoint,
      dataDir,
      workspace,
      workspaceId,
      sessionId,
    ),
  };
  const roster: CrossRunRosterResolver = {
    list: async (source) => listLocalRoster(
      source.endpoint,
      dataDir,
      workspace,
      workspaceId,
      sessionId,
    ),
  };
  const authorizer: CrossRunAuthorizer = {
    authorize: async (input) => authorizeLocalRoute(
      input,
      dataDir,
      workspace,
      workspaceId,
      sessionId,
      proofToken,
    ),
  };
  const targetAdmission: CrossRunTargetAdmission = {
    admit: (input) => admitLocalTarget(
      input,
      dataDir,
      workspace,
      workspaceId,
      proofToken,
      clock,
    ),
  };

  return {
    sender: (context) => sender(context),
    workspaceId,
    permissions: {
      relationships: LOCAL_RELATIONSHIPS,
      visibilities: LOCAL_VISIBILITIES,
      maxPriority: DEFAULT_MAX_PRIORITY,
    },
    routerOptions: {
      resolver,
      roster,
      authorizer,
      targetAdmission,
      verifySender: async (candidate) => (
        candidate.endpoint.workspaceId === workspaceId
        && candidate.proof.token === proofToken
      ),
      clock,
    },
  };
}

async function resolveLocalTarget(
  selector: CrossRunTargetSelector,
  source: CrossRunEndpoint,
  dataDir: string,
  workspace: string,
  workspaceId: string,
  sessionId: string,
): Promise<CrossRunResolvedTarget> {
  const entries = await localRosterEntries(
    source,
    dataDir,
    workspace,
    workspaceId,
    sessionId,
  );
  const candidates = entries.filter((entry) => entry.relationship === selector.relationship);
  const matching = candidates.filter((entry) => matchesSelector(entry, selector));
  if (matching.length !== 1) {
    throw new CrossRunProtocolError(
      matching.length === 0
        ? `${selector.relationship} target is unavailable`
        : `${selector.relationship} target selector is ambiguous`,
      matching.length === 0 ? "target-unavailable" : "selector-ambiguous",
    );
  }
  const entry = matching[0]!;
  if (!entry.reachable || entry.status === "inactive") {
    throw new CrossRunProtocolError("target is not reachable", "target-unavailable");
  }
  return {
    endpoint: structuredClone(entry.endpoint),
    relationship: entry.relationship,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    status: entry.status,
    reachable: entry.reachable,
  };
}

async function listLocalRoster(
  source: CrossRunEndpoint,
  dataDir: string,
  workspace: string,
  workspaceId: string,
  sessionId: string,
): Promise<CrossRunRoster> {
  const entries = await localRosterEntries(
    source,
    dataDir,
    workspace,
    workspaceId,
    sessionId,
  );
  return {
    current: structuredClone(source),
    entries: entries.filter((entry) => entry.reachable),
  };
}

async function localRosterEntries(
  source: CrossRunEndpoint,
  dataDir: string,
  workspace: string,
  workspaceId: string,
  _configuredSessionId: string,
): Promise<CrossRunRosterEntry[]> {
  if (source.workspaceId !== workspaceId || source.sessionId.length === 0) {
    throw new CrossRunProtocolError("source is outside the local A2A scope", "authorization-denied");
  }
  const runs = await listWorkspaceRuns(dataDir, workspace);
  const sessions = await readLocalSessionRegistry(dataDir, workspace);
  const sourceRun = runs.find((run) => run.runId === source.runId);
  if (sourceRun === undefined) {
    throw new CrossRunProtocolError("source Run is not present in the workspace", "target-unavailable");
  }

  const entries: CrossRunRosterEntry[] = [];
  for (const run of runs) {
    const relationships = relationshipFor(sourceRun.parentRunId, run.runId, sourceRun.runId, run.parentRunId);
    const liveSessions = sessions.filter((candidate) => (
      candidate.live && candidate.runId === run.runId
    ));
    const targetSessions = liveSessions.length > 0
      ? liveSessions
      : [{ sessionId: _configuredSessionId, state: run.status, live: false }];
    for (const targetSession of targetSessions) {
      const endpoint = endpointFor(run.runId, workspaceId, targetSession.sessionId);
      if (sameEndpoint(endpoint, source)) continue;
      const status = targetSession.live
        ? endpointStatusForSession(targetSession.state, run.status)
        : endpointStatus(run.status);
      const reachable = status !== "inactive";
      for (const relationship of relationships) {
        entries.push({ endpoint, relationship, status, reachable });
      }
    }
  }
  entries.sort(compareRosterEntries);
  return entries;
}

function relationshipFor(
  sourceParentRunId: string | undefined,
  candidateRunId: string,
  sourceRunId: string,
  candidateParentRunId: string | undefined,
): readonly CrossRunRelationship[] {
  const relationships: CrossRunRelationship[] = ["direct"];
  if (sourceParentRunId !== undefined && candidateRunId === sourceParentRunId) {
    relationships.push("parent");
  }
  if (candidateParentRunId === sourceRunId) relationships.push("child");
  if (
    sourceParentRunId !== undefined
    && candidateParentRunId === sourceParentRunId
  ) {
    relationships.push("sibling");
  }
  return relationships;
}

function matchesSelector(
  entry: CrossRunRosterEntry,
  selector: CrossRunTargetSelector,
): boolean {
  if (selector.relationship !== entry.relationship) return false;
  if ("id" in selector && selector.id !== undefined) {
    return selector.id === entry.endpoint.runId
      || selector.id === entry.endpoint.sessionId
      || selector.id === entry.endpoint.laneId;
  }
  if ("endpoint" in selector && selector.endpoint !== undefined) {
    return sameEndpoint(entry.endpoint, selector.endpoint);
  }
  if ("name" in selector && selector.name !== undefined) {
    return selector.name === entry.name;
  }
  return selector.relationship === "parent";
}

async function authorizeLocalRoute(
  input: CrossRunAuthorizationInput,
  dataDir: string,
  workspace: string,
  workspaceId: string,
  sessionId: string,
  proofToken: string,
): Promise<{ readonly allowed: boolean; readonly reason?: "authorization-denied" | "target-unavailable" }> {
  if (
    input.source.proof.token !== proofToken
    || input.source.endpoint.workspaceId !== workspaceId
    || input.target.workspaceId !== workspaceId
  ) {
    return { allowed: false, reason: "authorization-denied" };
  }
  const runs = await listWorkspaceRuns(dataDir, workspace);
  const target = runs.find((run) => run.runId === input.target.runId);
  return target === undefined
    ? { allowed: false, reason: "target-unavailable" }
    : { allowed: true };
}

async function admitLocalTarget(
  input: CrossRunTargetAdmissionInput,
  dataDir: string,
  workspace: string,
  workspaceId: string,
  proofToken: string,
  clock: Clock,
) {
  if (input.envelope.target.workspaceId !== workspaceId) {
    throw new CrossRunProtocolError("target is outside the local A2A scope", "authorization-denied");
  }
  const runs = await listWorkspaceRuns(dataDir, workspace);
  if (!runs.some((run) => run.runId === input.envelope.target.runId)) {
    throw new CrossRunProtocolError("target Run is not present in the workspace", "target-unavailable");
  }
  const ledgerPath = await targetLedgerPath(dataDir, input.envelope.target.runId);
  let ledger: JsonlLedger | undefined;
  try {
    try {
      ledger = await JsonlLedger.open(ledgerPath);
    } catch (error: unknown) {
      if (!(error instanceof LedgerWriterLockedError)) throw error;
      // The target Session owns the Ledger writer while it is live. Queue the
      // normalized message for that process to ingest under its own lock.
      const normalized = await normalizeTargetAdmission(
        input,
        input.envelope.target,
        async (sender) => (
          sender.proof.token === proofToken
          && sender.endpoint.workspaceId === workspaceId
        ),
      );
      return await enqueueLocalSessionMessage({
        dataDir,
        targetRunId: input.envelope.target.runId,
        message: normalized.message,
        queuedAt: clock.now().toISOString(),
      });
    }
    const admission = new LedgerCrossRunTargetAdmission({
      ledger,
      target: input.envelope.target,
      clock,
      verifySender: async (sender) => (
        sender.proof.token === proofToken
        && sender.endpoint.workspaceId === workspaceId
      ),
    });
    return await admission.admit(input);
  } finally {
    await ledger?.close().catch(() => undefined);
  }
}

async function targetLedgerPath(dataDir: string, runId: string): Promise<string> {
  const runsRoot = resolve(dataDir, "runs");
  const runPath = resolve(runsRoot, runId);
  const ledgerPath = resolve(runPath, "ledger.jsonl");
  if (!isWithin(runsRoot, runPath) || !isWithin(runPath, ledgerPath)) {
    throw new CrossRunProtocolError("target Run path is invalid", "target-unavailable");
  }
  const info = await lstat(ledgerPath).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
    throw new CrossRunProtocolError("target Run Ledger is unavailable", "target-unavailable");
  }
  return ledgerPath;
}

function endpointFor(
  runId: string,
  workspaceId: string,
  sessionId: string,
): CrossRunEndpoint {
  return { workspaceId, sessionId, runId, laneId: "main" };
}

function endpointStatus(status: WorkspaceRunStatus): CrossRunEndpointStatus {
  if (status === "active" || status === "waiting") return "busy";
  if (status === "ready" || status === "interrupted") return "idle";
  return "inactive";
}

function endpointStatusForSession(
  state: string,
  fallback: WorkspaceRunStatus,
): CrossRunEndpointStatus {
  if (state === "active" || state === "waiting" || state === "starting") return "busy";
  if (state === "offline" || state === "terminal") return endpointStatus(fallback);
  return "idle";
}

function compareRosterEntries(left: CrossRunRosterEntry, right: CrossRunRosterEntry): number {
  const leftKey = `${left.endpoint.runId}\u0000${left.endpoint.sessionId}\u0000${left.endpoint.laneId}\u0000${left.relationship}`;
  const rightKey = `${right.endpoint.runId}\u0000${right.endpoint.sessionId}\u0000${right.endpoint.laneId}\u0000${right.relationship}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".."
    && !relativePath.startsWith(`..${requirePathSeparator()}`)
    && !isAbsolute(relativePath)
  );
}

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function validateOptions(options: LocalCrossRunCompositionOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("local cross-Run composition options must be an object");
  }
  if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
    throw new TypeError("local cross-Run composition workspace must be non-empty");
  }
  if (typeof options.dataDir !== "string" || options.dataDir.trim().length === 0) {
    throw new TypeError("local cross-Run composition dataDir must be non-empty");
  }
  if (options.proofToken !== undefined && (
    typeof options.proofToken !== "string" || options.proofToken.trim().length === 0
  )) {
    throw new TypeError("local cross-Run composition proofToken must be non-empty");
  }
}
