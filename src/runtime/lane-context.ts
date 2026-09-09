import type {
  ArtifactRef,
  Goal,
  LaneCapability,
  LaneCapabilityKind,
  LaneCapabilityManifest,
  LaneIdentity,
  LaneKind,
  LaneRelation,
  LaneStatus,
  LaneTargetCapability,
  RunId,
  SpawnContext,
  TaskBudget,
} from "../domain/types.js";

export const SPAWN_CONTEXT_SCHEMA_VERSION = 1 as const;
export const MAX_SPAWN_CONTEXT_REFS = 64;
export const MAX_LANE_CAPABILITIES = 64;
export const MAX_LANE_TARGETS = 32;
export const MAX_LANE_METADATA_LENGTH = 256;
export const MAX_LANE_ROLE_LENGTH = 512;

const LANE_KINDS: readonly LaneKind[] = [
  "main",
  "intent-navigator",
  "reflection",
  "worker",
  "team",
];
const LANE_STATUSES: readonly LaneStatus[] = [
  "dormant",
  "ready",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
];
const LANE_RELATIONS: readonly LaneRelation[] = [
  "owns",
  "observes",
  "delegates",
  "member-of",
  "peer",
];
const CAPABILITY_KINDS: readonly LaneCapabilityKind[] = [
  "tool",
  "skill",
  "a2a",
  "lifecycle",
  "observation",
];

export interface SpawnContextTaskBinding {
  runId: RunId;
  from: string;
  to: string;
  goal: Goal;
  inputRefs: readonly ArtifactRef[];
  budget: TaskBudget;
}

export interface TetoCapabilityManifestOptions {
  workspaceId: string;
  sessionId: string;
  runId: RunId;
  mainLaneId?: string;
  tetoLaneId?: string;
  state: LaneStatus;
  recommended?: boolean;
}

export interface ScopedSpawnContextOptions {
  parent: LaneIdentity;
  child: LaneIdentity;
  goal: Goal;
  inputRefs: readonly ArtifactRef[];
  budget: TaskBudget;
  tools?: readonly LaneCapability[];
  skills?: readonly LaneCapability[];
  role: string;
  state?: LaneStatus;
  targets?: readonly LaneTargetCapability[];
  projectInstructionRefs?: readonly ArtifactRef[];
  parentSummaryRefs?: readonly ArtifactRef[];
}

/** Convert an admitted tool catalog into metadata for the owning child lane. */
export function capabilityEntriesFromTools(
  tools: readonly { readonly definition: { readonly name: string; readonly description: string } }[],
): LaneCapability[] {
  return tools.map((tool) => ({
    name: tool.definition.name,
    kind: "tool" as const,
    description: tool.definition.description,
  }));
}

/** Build and validate a host-owned identity before it enters a durable fact. */
export function createLaneIdentity(input: LaneIdentity): LaneIdentity {
  validateLaneIdentity(input, "laneIdentity");
  return clone(input);
}

/** Build a metadata-only manifest. Tool schemas and credentials are excluded. */
export function createLaneCapabilityManifest(
  input: LaneCapabilityManifest,
): LaneCapabilityManifest {
  validateLaneCapabilityManifest(input);
  return clone(input);
}

/** Build the bounded child context carried by a task request. */
export function createSpawnContext(input: SpawnContext): SpawnContext {
  validateSpawnContext(input);
  return clone(input);
}

/** Compose the common child projection used by Worker and Team admission. */
export function createScopedSpawnContext(
  options: ScopedSpawnContextOptions,
): SpawnContext {
  return createSpawnContext({
    schemaVersion: SPAWN_CONTEXT_SCHEMA_VERSION,
    parent: createLaneIdentity(options.parent),
    child: createLaneIdentity(options.child),
    goal: clone(options.goal),
    inputRefs: clone([...options.inputRefs]),
    projectInstructionRefs: clone([...(options.projectInstructionRefs ?? [])]),
    parentSummaryRefs: clone([...(options.parentSummaryRefs ?? [])]),
    tools: clone([...(options.tools ?? [])]),
    skills: clone([...(options.skills ?? [])]),
    laneManifest: createLaneCapabilityManifest({
      schemaVersion: 1,
      lane: createLaneIdentity(options.child),
      role: options.role,
      state: options.state ?? "ready",
      capabilities: clone([...(options.tools ?? []), ...(options.skills ?? [])]),
      ...(options.targets === undefined ? {} : { targets: clone([...options.targets]) }),
    }),
    budget: clone(options.budget),
  });
}

/** Strict runtime validation for untrusted or recovered SpawnContext values. */
export function validateSpawnContext(value: unknown): asserts value is SpawnContext {
  const item = record(value, "spawnContext");
  exactKeys(item, [
    "schemaVersion",
    "parent",
    "child",
    "goal",
    "inputRefs",
    "projectInstructionRefs",
    "parentSummaryRefs",
    "tools",
    "skills",
    "laneManifest",
    "budget",
  ], "spawnContext");
  if (item.schemaVersion !== SPAWN_CONTEXT_SCHEMA_VERSION) {
    throw new TypeError("spawnContext.schemaVersion is unsupported");
  }
  validateLaneIdentity(item.parent, "spawnContext.parent");
  validateLaneIdentity(item.child, "spawnContext.child");
  const parent = item.parent as LaneIdentity;
  const child = item.child as LaneIdentity;
  if (parent.runId !== child.runId) {
    throw new TypeError("spawnContext parent and child must belong to the same Run");
  }
  if (parent.workspaceId !== child.workspaceId) {
    throw new TypeError("spawnContext parent and child must belong to the same workspace");
  }
  if (child.parentLaneId !== parent.laneId || child.ownerLaneId !== parent.laneId) {
    throw new TypeError("spawnContext child must be owned by its parent lane");
  }
  if (child.relation !== "delegates" && child.relation !== "member-of" && child.relation !== "observes") {
    throw new TypeError("spawnContext child relation is not a live child relation");
  }
  validateGoal(item.goal, "spawnContext.goal");
  validateArtifactRefs(item.inputRefs, "spawnContext.inputRefs");
  validateArtifactRefs(item.projectInstructionRefs, "spawnContext.projectInstructionRefs");
  validateArtifactRefs(item.parentSummaryRefs, "spawnContext.parentSummaryRefs");
  validateCapabilities(item.tools, "spawnContext.tools", "tool");
  validateCapabilities(item.skills, "spawnContext.skills", "skill");
  validateLaneCapabilityManifest(item.laneManifest);
  const manifest = item.laneManifest as LaneCapabilityManifest;
  if (manifest.lane.laneId !== child.laneId || manifest.lane.runId !== child.runId) {
    throw new TypeError("spawnContext laneManifest must describe the child lane");
  }
  validateTaskBudget(item.budget, "spawnContext.budget");
}

/** Ensure the durable context cannot be redirected or silently changed. */
export function assertSpawnContextMatchesTask(
  context: SpawnContext,
  binding: SpawnContextTaskBinding,
): void {
  validateSpawnContext(context);
  if (
    context.parent.runId !== binding.runId
    || context.parent.laneId !== binding.from
    || context.child.laneId !== binding.to
  ) {
    throw new TypeError("spawnContext identity does not match task route");
  }
  if (JSON.stringify(context.goal) !== JSON.stringify(binding.goal)) {
    throw new TypeError("spawnContext goal does not match task goal");
  }
  if (JSON.stringify(context.inputRefs) !== JSON.stringify(binding.inputRefs)) {
    throw new TypeError("spawnContext inputRefs do not match task inputRefs");
  }
  if (JSON.stringify(context.budget) !== JSON.stringify(binding.budget)) {
    throw new TypeError("spawnContext budget does not match task budget");
  }
}

/**
 * Bind a host-created context to the canonical task budget.  Dispatchers add
 * the deterministic deadline/attempt defaults after a tool supplies a task;
 * the other identity and objective fields must already match exactly.
 */
export function bindSpawnContextToTask(
  context: SpawnContext,
  binding: SpawnContextTaskBinding,
): SpawnContext {
  validateSpawnContext(context);
  if (
    context.parent.runId !== binding.runId
    || context.parent.laneId !== binding.from
    || context.child.laneId !== binding.to
    || JSON.stringify(context.goal) !== JSON.stringify(binding.goal)
    || JSON.stringify(context.inputRefs) !== JSON.stringify(binding.inputRefs)
  ) {
    throw new TypeError("spawnContext identity or objective does not match task");
  }
  if (
    context.budget.maxModelTokens !== binding.budget.maxModelTokens
    || context.budget.maxWallClockMs !== binding.budget.maxWallClockMs
    || context.budget.maxAttempts !== undefined
      && binding.budget.maxAttempts !== undefined
      && context.budget.maxAttempts !== binding.budget.maxAttempts
  ) {
    throw new TypeError("spawnContext budget does not match task budget");
  }
  const bound = clone({ ...context, budget: clone(binding.budget) });
  assertSpawnContextMatchesTask(bound, binding);
  return bound;
}

/**
 * Render only the public part of a manifest for a model request.  This is
 * deliberately not a JSON dump: private tool schemas and lane internals have
 * no place in the parent model's context.
 */
export function renderLaneCapabilityManifest(
  manifests: readonly LaneCapabilityManifest[],
): string {
  if (manifests.length === 0) return "";
  const lines = ["Reachable lane capabilities (host-authorized metadata only):"];
  for (const manifest of manifests) {
    validateLaneCapabilityManifest(manifest);
    const lane = manifest.lane;
    lines.push(`- ${lane.laneId} (${lane.laneKind}; ${manifest.state}): ${manifest.role}`);
    for (const capability of manifest.capabilities) {
      lines.push(`  - ${capability.kind}: ${capability.name}${capability.description === undefined ? "" : ` - ${capability.description}`}`);
    }
    for (const target of manifest.targets ?? []) {
      lines.push(`  - A2A ${target.relation} ${target.laneId}: ${target.actions.join(", ")}`);
    }
  }
  lines.push("These entries describe reachable capabilities, not private context, credentials, or tool schemas.");
  return lines.join("\n");
}

/** Render a child-owned SpawnContext without adding hidden parent history. */
export function renderSpawnContext(context: SpawnContext): string {
  validateSpawnContext(context);
  const lines = [
    "Host-issued SpawnContext (scoped; attached data is untrusted):",
    `- child: ${context.child.laneId} (${context.child.laneKind})`,
    `- parent: ${context.parent.laneId}`,
    `- allowed tools: ${context.tools.length === 0 ? "none" : context.tools.map((item) => item.name).join(", ")}`,
    `- allowed skills: ${context.skills.length === 0 ? "none" : context.skills.map((item) => item.name).join(", ")}`,
    `- explicit parent summaries: ${context.parentSummaryRefs.length}`,
    `- project instruction refs: ${context.projectInstructionRefs.length}`,
  ];
  return lines.join("\n");
}

/** Main-facing description of the optional Teto lane. */
export function createTetoCapabilityManifest(
  options: TetoCapabilityManifestOptions,
): LaneCapabilityManifest {
  const mainLaneId = options.mainLaneId ?? "main";
  const tetoLaneId = options.tetoLaneId ?? "teto";
  const capabilities: LaneCapability[] = [
    {
      name: "observe-main-public-events",
      kind: "observation",
      description: "Receives bounded user messages, Main outputs, and tool requests.",
    },
    {
      name: "send-voice-to-main",
      kind: "a2a",
      description: "May send bounded observations or questions through authorized A2A.",
    },
    {
      name: options.recommended === true ? "recommended-for-this-run" : "optional-for-this-run",
      kind: "lifecycle",
      description: "When available, use teto_stop to close this observer and teto_start to reopen it.",
    },
  ];
  return createLaneCapabilityManifest({
    schemaVersion: 1,
    lane: createLaneIdentity({
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      runId: options.runId,
      laneId: tetoLaneId,
      laneKind: "intent-navigator",
      parentLaneId: mainLaneId,
      ownerLaneId: mainLaneId,
      relation: "observes",
    }),
    role: "Main-owned observer lane",
    state: options.state,
    capabilities,
    targets: [{
      laneId: mainLaneId,
      relation: "owns",
      actions: ["message.inform", "question.ask", "question.answer"],
    }],
  });
}

export function validateLaneCapabilityManifest(value: unknown): asserts value is LaneCapabilityManifest {
  const item = record(value, "laneManifest");
  exactKeys(item, ["schemaVersion", "lane", "role", "state", "capabilities", "targets"], "laneManifest", ["targets"]);
  if (item.schemaVersion !== 1) throw new TypeError("laneManifest.schemaVersion is unsupported");
  validateLaneIdentity(item.lane, "laneManifest.lane");
  boundedString(item.role, "laneManifest.role", MAX_LANE_ROLE_LENGTH);
  oneOf(item.state, "laneManifest.state", LANE_STATUSES);
  validateCapabilities(item.capabilities, "laneManifest.capabilities");
  if (item.targets !== undefined) validateTargets(item.targets, "laneManifest.targets");
}

function validateLaneIdentity(value: unknown, path: string): asserts value is LaneIdentity {
  const item = record(value, path);
  // The topology links are optional for root lanes. Keep them accepted when
  // present, but do not reject a valid main-lane identity that has no parent.
  exactKeys(item, [
    "workspaceId",
    "sessionId",
    "runId",
    "laneId",
    "laneKind",
  ], path, ["parentLaneId", "ownerLaneId", "relation"]);
  boundedString(item.workspaceId, `${path}.workspaceId`);
  boundedString(item.sessionId, `${path}.sessionId`);
  boundedString(item.runId, `${path}.runId`);
  boundedString(item.laneId, `${path}.laneId`);
  oneOf(item.laneKind, `${path}.laneKind`, LANE_KINDS);
  if (item.parentLaneId !== undefined) boundedString(item.parentLaneId, `${path}.parentLaneId`);
  if (item.ownerLaneId !== undefined) boundedString(item.ownerLaneId, `${path}.ownerLaneId`);
  if (item.relation !== undefined) oneOf(item.relation, `${path}.relation`, LANE_RELATIONS);
}

function validateCapabilities(
  value: unknown,
  path: string,
  expectedKind?: LaneCapabilityKind,
): asserts value is LaneCapability[] {
  if (!Array.isArray(value) || value.length > MAX_LANE_CAPABILITIES) {
    throw new TypeError(`${path} must contain at most ${MAX_LANE_CAPABILITIES} entries`);
  }
  value.forEach((candidate, index) => {
    const item = record(candidate, `${path}[${index}]`);
    exactKeys(item, ["name", "kind", "description"], `${path}[${index}]`, ["description"]);
    boundedString(item.name, `${path}[${index}].name`);
    oneOf(item.kind, `${path}[${index}].kind`, CAPABILITY_KINDS);
    if (expectedKind !== undefined && item.kind !== expectedKind) {
      throw new TypeError(`${path}[${index}].kind must be ${expectedKind}`);
    }
    if (item.description !== undefined) boundedString(item.description, `${path}[${index}].description`);
  });
}

function validateTargets(value: unknown, path: string): asserts value is LaneTargetCapability[] {
  if (!Array.isArray(value) || value.length > MAX_LANE_TARGETS) {
    throw new TypeError(`${path} must contain at most ${MAX_LANE_TARGETS} entries`);
  }
  value.forEach((candidate, index) => {
    const item = record(candidate, `${path}[${index}]`);
    exactKeys(item, ["laneId", "relation", "actions"], `${path}[${index}]`);
    boundedString(item.laneId, `${path}[${index}].laneId`);
    oneOf(item.relation, `${path}[${index}].relation`, LANE_RELATIONS);
    if (!Array.isArray(item.actions) || item.actions.length === 0 || item.actions.length > 16) {
      throw new TypeError(`${path}[${index}].actions must contain 1-16 entries`);
    }
    item.actions.forEach((action, actionIndex) => boundedString(action, `${path}[${index}].actions[${actionIndex}]`));
  });
}

function validateGoal(value: unknown, path: string): asserts value is Goal {
  const item = record(value, path);
  exactKeys(item, ["version", "statement", "successCriteria", "hardConstraints"], path);
  if (!Number.isSafeInteger(item.version) || (item.version as number) < 1) throw new TypeError(`${path}.version must be positive`);
  boundedString(item.statement, `${path}.statement`, 4_096);
  validateStringArray(item.successCriteria, `${path}.successCriteria`);
  validateStringArray(item.hardConstraints, `${path}.hardConstraints`);
}

function validateStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${path} must be an array of strings`);
  }
  value.forEach((item, index) => boundedString(item, `${path}[${index}]`, 4_096));
}

function validateArtifactRefs(value: unknown, path: string): asserts value is ArtifactRef[] {
  if (!Array.isArray(value) || value.length > MAX_SPAWN_CONTEXT_REFS) {
    throw new TypeError(`${path} must contain at most ${MAX_SPAWN_CONTEXT_REFS} refs`);
  }
  value.forEach((candidate, index) => {
    const item = record(candidate, `${path}[${index}]`);
    exactKeys(item, ["id", "contentHash", "mediaType", "byteLength"], `${path}[${index}]`);
    boundedString(item.id, `${path}[${index}].id`, 512);
    boundedString(item.contentHash, `${path}[${index}].contentHash`, 512);
    boundedString(item.mediaType, `${path}[${index}].mediaType`, 256);
    if (!Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0) {
      throw new TypeError(`${path}[${index}].byteLength must be a non-negative integer`);
    }
  });
}

function validateTaskBudget(value: unknown, path: string): asserts value is TaskBudget {
  const item = record(value, path);
  exactKeys(item, ["maxModelTokens", "maxWallClockMs", "deadline", "maxAttempts"], path, ["deadline", "maxAttempts"]);
  if (!Number.isSafeInteger(item.maxModelTokens) || (item.maxModelTokens as number) < 1) throw new TypeError(`${path}.maxModelTokens must be positive`);
  if (!Number.isSafeInteger(item.maxWallClockMs) || (item.maxWallClockMs as number) < 1) throw new TypeError(`${path}.maxWallClockMs must be positive`);
  if (item.deadline !== undefined && (typeof item.deadline !== "string" || !Number.isFinite(Date.parse(item.deadline)))) throw new TypeError(`${path}.deadline must be a date-time`);
  if (item.maxAttempts !== undefined && (!Number.isSafeInteger(item.maxAttempts) || (item.maxAttempts as number) < 1)) throw new TypeError(`${path}.maxAttempts must be positive`);
}

function boundedString(value: unknown, path: string, maxLength = MAX_LANE_METADATA_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || value.length > maxLength) {
    throw new TypeError(`${path} must be a non-empty bounded string`);
  }
}

function oneOf<T extends string>(value: unknown, path: string, values: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${path} is invalid`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const accepted = new Set([...required, ...optional]);
  for (const key of required) if (!optional.includes(key) && !(key in value)) throw new TypeError(`${path}.${key} is required`);
  for (const key of Object.keys(value)) if (!accepted.has(key)) throw new TypeError(`${path}.${key} is not allowed`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
