import type { AgentTool, JsonSchema, ToolDefinition } from "../domain/ports.js";
import { cloneJson, sha256, stableJson } from "../ledger/hash.js";
import type { MoweAgentTool, MoweToolMetadata } from "./types.js";
import {
  EDGE_MANIFEST_VERSION,
  type CreateEdgeCapabilityOptions,
  type CreateEdgeCapabilitySnapshotOptions,
  type EdgeAdapter,
  type EdgeAdapterErrorCode,
  type EdgeAdapterFailure,
  type EdgeAdapterPhase,
  type EdgeCapability,
  type EdgeCapabilitySnapshot,
  type EdgeContextContribution,
  type EdgeContextContributionSummary,
  type EdgeManifest,
  type EdgeManifestInput,
  type EdgeProvenance,
  type EdgeRecoverySemantics,
  type EdgeSourceType,
} from "./edge-types.js";

const SOURCE_TYPES: readonly EdgeSourceType[] = ["skill", "mcp", "plugin"];
const EFFECTS: readonly EdgeManifest["effect"][] = ["read", "compute", "write", "external"];
const SCOPES: readonly EdgeManifest["scope"][] = ["workspace", "run", "lane", "host"];
const RECOVERY_SEMANTICS: readonly EdgeRecoverySemantics[] = ["none", "retry", "reconcile"];
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const MAX_EDGE_MANIFEST_BYTES = 1024 * 1024;
export const MAX_EDGE_SCHEMA_BYTES = 512 * 1024;
export const MAX_EDGE_JSON_DEPTH = 64;
export const MAX_EDGE_JSON_NODES = 50_000;
const MAX_EDGE_STRING_BYTES = 64 * 1024;
const MAX_EDGE_IDENTITY_BYTES = 512;
export const MAX_EDGE_CONTEXT_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_EDGE_CONTEXT_CONTRIBUTIONS = 4_096;
// Host-granted metadata is intentionally not inferred from object shape.  A
// capability entering a public snapshot must either satisfy the manifest
// contract strictly or be the exact object produced by the host rebind path.
const REBOUND_CAPABILITIES = new WeakSet<object>();
const MANIFEST_KEYS = [
  "manifestVersion",
  "sourceId",
  "sourceType",
  "capabilityName",
  "capabilityVersion",
  "schemaVersion",
  "description",
  "inputSchema",
  "outputSchema",
  "effect",
  "scope",
  "cancellable",
  "idempotent",
  "recovery",
  "adapterVersion",
  "adapterCompatibility",
  "provenance",
] as const;
const PROVENANCE_KEYS = [
  "upstreamName",
  "upstreamVersion",
  "license",
  "author",
  "sourceUri",
] as const;

export class EdgeContractError extends TypeError {
  override readonly name = "EdgeContractError";

  constructor(readonly path: string, message: string) {
    super(`Invalid edge contract at ${path}: ${message}`);
  }
}

/** Structured adapter error that can be projected without exposing its cause. */
export class EdgeAdapterError extends Error implements EdgeAdapterFailure {
  override readonly name = "EdgeAdapterError";
  readonly code: EdgeAdapterErrorCode;
  readonly phase: EdgeAdapterPhase;
  readonly sourceId: string;
  readonly sourceType: EdgeSourceType;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(failure: EdgeAdapterFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.code = failure.code;
    this.phase = failure.phase;
    this.sourceId = failure.sourceId;
    this.sourceType = failure.sourceType;
    this.retryable = failure.retryable;
    if (failure.retryAfterMs !== undefined) this.retryAfterMs = failure.retryAfterMs;
  }

  toFailure(): EdgeAdapterFailure {
    return deepFreeze({
      code: this.code,
      phase: this.phase,
      sourceId: this.sourceId,
      sourceType: this.sourceType,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    });
  }
}

/** Validate, hash, clone, and deeply freeze a newly discovered manifest. */
export function createEdgeManifest(input: EdgeManifestInput): EdgeManifest {
  const normalized = normalizeManifest(input, false);
  return deepFreeze({
    ...normalized,
    manifestHash: hashManifestPayload(normalized),
  });
}

/** Validate an untrusted persisted manifest and verify its canonical hash. */
export function validateEdgeManifest(value: unknown): EdgeManifest {
  const normalized = normalizeManifest(value, true);
  const record = asRecord(value, "manifest");
  const manifestHash = requiredString(record.manifestHash, "manifest.manifestHash");
  if (!HASH_PATTERN.test(manifestHash)) {
    fail("manifest.manifestHash", "must be a lowercase sha256 digest");
  }
  const expected = hashManifestPayload(normalized);
  if (manifestHash !== expected) {
    fail("manifest.manifestHash", `does not match canonical manifest ${expected}`);
  }
  return deepFreeze({ ...normalized, manifestHash });
}

/** Compute the identity of a validated manifest payload without trusting a supplied hash. */
export function edgeManifestHash(input: EdgeManifestInput): string {
  return hashManifestPayload(normalizeManifest(input, false));
}

/** Validate and freeze a summary without loading its context body. */
export function createEdgeContextContributionSummary(
  input: EdgeContextContributionSummary,
): EdgeContextContributionSummary {
  return normalizeContextContribution(input, false);
}

/** Validate a discovered or persisted summary supplied by an untrusted edge. */
export function validateEdgeContextContributionSummary(value: unknown): EdgeContextContributionSummary {
  return normalizeContextContribution(value, false);
}

/** Validate and freeze one explicitly loaded context contribution. */
export function createEdgeContextContribution(
  input: EdgeContextContribution,
): EdgeContextContribution {
  return normalizeContextContribution(input, true);
}

/** Validate a loaded contribution and verify its body hash against its summary. */
export function validateEdgeContextContribution(value: unknown): EdgeContextContribution {
  return normalizeContextContribution(value, true);
}

/** Stable identity hash for a context contribution (body hash included when present). */
export function edgeContextContributionHash(
  input: EdgeContextContributionSummary | EdgeContextContribution,
): string {
  const hasBody = isRecord(input) && "body" in input;
  const normalized = normalizeContextContribution(input, hasBody);
  return sha256(stableJson(normalized));
}

/** Ensure a discovered document cannot claim another adapter's identity. */
export function assertEdgeAdapterOwnsManifest(
  adapter: Pick<EdgeAdapter, "sourceId" | "sourceType">,
  manifest: EdgeManifest,
): void {
  const sourceId = requiredIdentity(adapter.sourceId, "adapter.sourceId");
  if (!SOURCE_TYPES.includes(adapter.sourceType)) {
    fail("adapter.sourceType", "must be skill, mcp, or plugin");
  }
  if (manifest.sourceId !== sourceId || manifest.sourceType !== adapter.sourceType) {
    fail(
      "manifest.sourceId",
      `must belong to adapter ${adapter.sourceType}:${sourceId}`,
    );
  }
}

/**
 * Pin an AgentTool definition and Mowe metadata to a validated manifest. The
 * execute function is captured so later property replacement cannot drift a
 * Turn that already holds this capability.
 */
export function createEdgeCapability(options: CreateEdgeCapabilityOptions): EdgeCapability {
  return createEdgeCapabilityInternal(options, false);
}

/**
 * Rebind a validated capability to host-owned metadata.  Edge declarations are
 * requests, so the registry may deliberately quarantine an ungranted edge as
 * `external/host/approval-required` without changing the provenance manifest.
 */
export function rebindEdgeCapabilityMetadata(
  capability: EdgeCapability,
  metadata: MoweToolMetadata,
): EdgeCapability {
  const rebound = createEdgeCapabilityInternal({
    manifest: capability.manifest,
    tool: capability.tool,
    metadata,
  }, true);
  REBOUND_CAPABILITIES.add(rebound);
  return rebound;
}

function createEdgeCapabilityInternal(
  options: CreateEdgeCapabilityOptions,
  allowBoundaryOverride: boolean,
): EdgeCapability {
  const manifest = validateEdgeManifest(options.manifest);
  const definition = normalizeToolDefinition(options.tool.definition);
  if (definition.name !== manifest.capabilityName) {
    fail("tool.definition.name", `must equal manifest capabilityName ${manifest.capabilityName}`);
  }
  if (definition.description !== manifest.description) {
    fail("tool.definition.description", "must equal manifest description");
  }
  if (stableJson(definition.parameters) !== stableJson(manifest.inputSchema)) {
    fail("tool.definition.parameters", "must equal manifest inputSchema");
  }
  if (typeof options.tool.execute !== "function") {
    fail("tool.execute", "must be a function");
  }

  const embedded = (options.tool as MoweAgentTool).metadata;
  const metadata = normalizeCapabilityMetadata(
    manifest,
    embedded,
    options.metadata,
    allowBoundaryOverride,
  );
  // AgentTool implementations conventionally do not use `this`; binding a
  // frozen receiver prevents a mutable provider object from changing the
  // behavior of a capability after it has been published.
  const receiver = Object.freeze({
    definition: deepFreeze(structuredClone(definition)),
    ...(metadata === undefined ? {} : { metadata }),
  });
  const executeImplementation = options.tool.execute;
  const execute = Object.freeze((...args: Parameters<AgentTool["execute"]>) => (
    executeImplementation.call(receiver, ...args)
  ));
  const tool: MoweAgentTool = Object.freeze({
    definition: deepFreeze(definition),
    execute,
    metadata,
  });
  return Object.freeze({ manifest, tool });
}

/** Build the immutable, deterministic capability view held by one Turn. */
export function createEdgeCapabilitySnapshot(
  options: CreateEdgeCapabilitySnapshotOptions,
): EdgeCapabilitySnapshot {
  if (!Number.isSafeInteger(options.generation) || options.generation < 0) {
    fail("snapshot.generation", "must be a non-negative safe integer");
  }
  const createdAt = requiredString(options.createdAt, "snapshot.createdAt");
  const createdAtMilliseconds = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMilliseconds)
    || new Date(createdAtMilliseconds).toISOString() !== createdAt) {
    fail("snapshot.createdAt", "must be a canonical ISO-8601 timestamp");
  }
  if (!Array.isArray(options.capabilities)) {
    fail("snapshot.capabilities", "must be an array");
  }

  const names = new Set<string>();
  const capabilities = options.capabilities.map((candidate, index) => {
    const record = asRecord(candidate, `snapshot.capabilities[${index}]`);
    const tool = record.tool as MoweAgentTool;
    const candidateCapability = candidate as EdgeCapability;
    const capability = createEdgeCapabilityInternal({
      manifest: record.manifest as EdgeManifest,
      tool,
      ...(tool.metadata === undefined ? {} : { metadata: tool.metadata }),
    }, REBOUND_CAPABILITIES.has(candidateCapability));
    const name = capability.manifest.capabilityName;
    if (names.has(name)) {
      fail(`snapshot.capabilities[${index}].manifest.capabilityName`, `duplicate capability ${name}`);
    }
    names.add(name);
    return capability;
  }).sort(compareCapabilities);

  const snapshotHash = sha256(stableJson({
    generation: options.generation,
    capabilities: capabilities.map(({ manifest, tool }) => ({
      manifestHash: manifest.manifestHash,
      definition: tool.definition,
      metadata: tool.metadata ?? {},
    })),
  }));
  return Object.freeze({
    generation: options.generation,
    createdAt,
    snapshotHash,
    capabilities: Object.freeze(capabilities),
  });
}

function normalizeManifest(value: unknown, requireHash: boolean): EdgeManifestInput {
  const record = asRecord(value, "manifest");
  assertExactKeys(record, requireHash ? [...MANIFEST_KEYS, "manifestHash"] : MANIFEST_KEYS, "manifest");
  if (record.manifestVersion !== EDGE_MANIFEST_VERSION) {
    fail("manifest.manifestVersion", `must equal ${EDGE_MANIFEST_VERSION}`);
  }
  if (!SOURCE_TYPES.includes(record.sourceType as EdgeSourceType)) {
    fail("manifest.sourceType", "must be skill, mcp, or plugin");
  }
  if (!EFFECTS.includes(record.effect as EdgeManifest["effect"])) {
    fail("manifest.effect", "must be read, compute, write, or external");
  }
  if (!SCOPES.includes(record.scope as EdgeManifest["scope"])) {
    fail("manifest.scope", "must be workspace, run, lane, or host");
  }
  if (!RECOVERY_SEMANTICS.includes(record.recovery as EdgeRecoverySemantics)) {
    fail("manifest.recovery", "must be none, retry, or reconcile");
  }
  const cancellable = requiredBoolean(record.cancellable, "manifest.cancellable");
  const idempotent = requiredBoolean(record.idempotent, "manifest.idempotent");
  if (record.recovery === "retry" && !idempotent) {
    fail("manifest.recovery", "retry requires an idempotent capability");
  }

  const provenance = normalizeProvenance(record.provenance);
  const normalized: EdgeManifestInput = {
    manifestVersion: EDGE_MANIFEST_VERSION,
    sourceId: requiredIdentity(record.sourceId, "manifest.sourceId"),
    sourceType: record.sourceType as EdgeSourceType,
    capabilityName: requiredIdentity(record.capabilityName, "manifest.capabilityName"),
    capabilityVersion: requiredIdentity(record.capabilityVersion, "manifest.capabilityVersion"),
    schemaVersion: requiredIdentity(record.schemaVersion, "manifest.schemaVersion"),
    description: requiredString(record.description, "manifest.description"),
    inputSchema: normalizeSchema(record.inputSchema, "manifest.inputSchema"),
    outputSchema: normalizeSchema(record.outputSchema, "manifest.outputSchema"),
    effect: record.effect as EdgeManifest["effect"],
    scope: record.scope as EdgeManifest["scope"],
    cancellable,
    idempotent,
    recovery: record.recovery as EdgeRecoverySemantics,
    adapterVersion: requiredIdentity(record.adapterVersion, "manifest.adapterVersion"),
    adapterCompatibility: requiredString(
      record.adapterCompatibility,
      "manifest.adapterCompatibility",
    ),
    provenance,
  };
  if (Buffer.byteLength(stableJson(normalized), "utf8") > MAX_EDGE_MANIFEST_BYTES) {
    fail("manifest", `must not exceed ${MAX_EDGE_MANIFEST_BYTES} UTF-8 bytes`);
  }
  return deepFreeze(normalized);
}

function normalizeContextContribution(
  value: unknown,
  requireBody: boolean,
): EdgeContextContribution | EdgeContextContributionSummary {
  const record = asRecord(value, "context contribution");
  const keys = [
    "kind",
    "sourceId",
    "contributionId",
    "sourceType",
    "name",
    "description",
    "disabled",
    "contentHash",
    "provenance",
    ...(requireBody ? ["body"] : []),
  ];
  assertExactKeys(record, keys, "context contribution", [
    "contentHash",
    "provenance",
    ...(requireBody ? ["body"] : []),
  ]);
  if (record.kind !== "context") fail("context contribution.kind", "must equal context");
  if (record.sourceType !== "skill" && record.sourceType !== "plugin") {
    fail("context contribution.sourceType", "must be skill or plugin");
  }
  const contentHash = optionalContentHash(record.contentHash, "context contribution.contentHash");
  const body = optionalBody(record.body, "context contribution.body");
  if (body !== undefined && contentHash !== undefined && sha256(body) !== contentHash) {
    fail("context contribution.contentHash", "does not match body");
  }
  const provenance = record.provenance === undefined
    ? undefined
    : normalizeContextProvenance(record.provenance);
  const normalized = {
    kind: "context" as const,
    sourceId: requiredIdentity(record.sourceId, "context contribution.sourceId"),
    contributionId: requiredIdentity(
      record.contributionId,
      "context contribution.contributionId",
    ),
    sourceType: record.sourceType as "skill" | "plugin",
    name: requiredIdentity(record.name, "context contribution.name"),
    description: requiredString(record.description, "context contribution.description"),
    disabled: requiredBoolean(record.disabled, "context contribution.disabled"),
    ...(body === undefined ? {} : { body }),
    ...(contentHash === undefined
      ? (body === undefined ? {} : { contentHash: sha256(body) })
      : { contentHash }),
    ...(provenance === undefined ? {} : { provenance }),
  } satisfies EdgeContextContribution;
  return deepFreeze(normalized);
}

function normalizeContextProvenance(value: unknown): EdgeProvenance {
  const record = asRecord(value, "context contribution.provenance");
  assertExactKeys(record, PROVENANCE_KEYS, "context contribution.provenance");
  const author = optionalString(record.author, "context contribution.provenance.author");
  const sourceUri = optionalString(record.sourceUri, "context contribution.provenance.sourceUri");
  return deepFreeze({
    upstreamName: requiredString(record.upstreamName, "context contribution.provenance.upstreamName"),
    upstreamVersion: requiredIdentity(
      record.upstreamVersion,
      "context contribution.provenance.upstreamVersion",
    ),
    license: requiredString(record.license, "context contribution.provenance.license"),
    ...(author === undefined ? {} : { author }),
    ...(sourceUri === undefined ? {} : { sourceUri }),
  });
}

function normalizeProvenance(value: unknown): EdgeProvenance {
  const record = asRecord(value, "manifest.provenance");
  assertExactKeys(record, PROVENANCE_KEYS, "manifest.provenance");
  const author = optionalString(record.author, "manifest.provenance.author");
  const sourceUri = optionalString(record.sourceUri, "manifest.provenance.sourceUri");
  if (author === undefined && sourceUri === undefined) {
    fail("manifest.provenance", "must include author or sourceUri");
  }
  return deepFreeze({
    upstreamName: requiredString(record.upstreamName, "manifest.provenance.upstreamName"),
    upstreamVersion: requiredIdentity(
      record.upstreamVersion,
      "manifest.provenance.upstreamVersion",
    ),
    license: requiredString(record.license, "manifest.provenance.license"),
    ...(author === undefined ? {} : { author }),
    ...(sourceUri === undefined ? {} : { sourceUri }),
  });
}

function normalizeSchema(value: unknown, path: string): JsonSchema {
  assertJsonValue(value, path, new Set<object>(), { nodes: 0 }, 0);
  const record = asRecord(value, path);
  if (record.type !== "object") fail(`${path}.type`, "must equal object");
  validateSchemaNode(record, path, 0);
  if (Buffer.byteLength(stableJson(record), "utf8") > MAX_EDGE_SCHEMA_BYTES) {
    fail(path, `must not exceed ${MAX_EDGE_SCHEMA_BYTES} UTF-8 bytes`);
  }
  return deepFreeze(cloneJson(record) as unknown as JsonSchema);
}

function normalizeToolDefinition(value: unknown): ToolDefinition {
  const record = asRecord(value, "tool.definition");
  assertExactKeys(record, ["name", "description", "parameters"], "tool.definition");
  return {
    name: requiredIdentity(record.name, "tool.definition.name"),
    description: requiredString(record.description, "tool.definition.description"),
    parameters: normalizeSchema(record.parameters, "tool.definition.parameters"),
  };
}

function normalizeCapabilityMetadata(
  manifest: EdgeManifest,
  embedded: MoweToolMetadata | undefined,
  supplied: MoweToolMetadata | undefined,
  allowBoundaryOverride = false,
): MoweToolMetadata {
  for (const [label, metadata] of [["tool.metadata", embedded], ["metadata", supplied]] as const) {
    if (metadata === undefined) continue;
    if (!isRecord(metadata)) fail(label, "must be an object");
    if (!allowBoundaryOverride && metadata.effect !== undefined && metadata.effect !== manifest.effect) {
      fail(`${label}.effect`, `must equal manifest effect ${manifest.effect}`);
    }
    if (!allowBoundaryOverride && metadata.scope !== undefined && metadata.scope !== manifest.scope) {
      fail(`${label}.scope`, `must equal manifest scope ${manifest.scope}`);
    }
    if (metadata.version !== undefined && metadata.version !== manifest.capabilityVersion) {
      fail(`${label}.version`, `must equal manifest capabilityVersion ${manifest.capabilityVersion}`);
    }
  }
  const merged = {
    ...cloneMetadata(embedded),
    ...cloneMetadata(supplied),
    effect: allowBoundaryOverride
      ? (supplied?.effect ?? embedded?.effect ?? manifest.effect)
      : manifest.effect,
    scope: allowBoundaryOverride
      ? (supplied?.scope ?? embedded?.scope ?? manifest.scope)
      : manifest.scope,
    version: manifest.capabilityVersion,
  } satisfies MoweToolMetadata;
  if (!EFFECTS.includes(merged.effect as EdgeManifest["effect"])) {
    fail("metadata.effect", "must be read, compute, write, or external");
  }
  if (!SCOPES.includes(merged.scope as EdgeManifest["scope"])) {
    fail("metadata.scope", "must be workspace, run, lane, or host");
  }
  // A non-idempotent declaration is never safe to treat as deterministic or
  // freely parallelizable, even when an adapter supplied optimistic hints.
  if (!manifest.idempotent) {
    merged.deterministic = false;
    merged.supportsBatch = false;
    merged.concurrencySafe = false;
  }
  return deepFreeze(merged);
}

function cloneMetadata(metadata: MoweToolMetadata | undefined): MoweToolMetadata {
  if (metadata === undefined) return {};
  assertJsonValue(metadata, "metadata");
  return cloneJson(metadata);
}

function hashManifestPayload(manifest: EdgeManifestInput): string {
  return sha256(stableJson(manifest));
}

function compareCapabilities(left: EdgeCapability, right: EdgeCapability): number {
  return compareText(left.manifest.capabilityName, right.manifest.capabilityName)
    || compareText(left.manifest.sourceId, right.manifest.sourceId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
  optional: readonly string[] = ["author", "sourceUri"],
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key)).sort()[0];
  if (unknown !== undefined) fail(`${path}.${unknown}`, "is not supported");
  const optionalKeys = new Set(optional);
  for (const key of expected) {
    if (!(key in record) && !optionalKeys.has(key)) {
      fail(`${path}.${key}`, "is required");
    }
  }
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen = new Set<object>(),
  budget: { nodes: number } = { nodes: 0 },
  depth = 0,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_EDGE_JSON_NODES) fail(path, `must not exceed ${MAX_EDGE_JSON_NODES} JSON nodes`);
  if (depth > MAX_EDGE_JSON_DEPTH) fail(path, `must not exceed JSON depth ${MAX_EDGE_JSON_DEPTH}`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_EDGE_STRING_BYTES) {
      fail(path, `string must not exceed ${MAX_EDGE_STRING_BYTES} UTF-8 bytes`);
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite JSON numbers");
    return;
  }
  if (typeof value !== "object") fail(path, "must be JSON serializable");
  if (seen.has(value)) fail(path, "must not contain cycles");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen, budget, depth + 1));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, "must contain only plain JSON objects");
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (Buffer.byteLength(key, "utf8") > MAX_EDGE_IDENTITY_BYTES) {
        fail(path, `object keys must not exceed ${MAX_EDGE_IDENTITY_BYTES} UTF-8 bytes`);
      }
      assertJsonValue(item, `${path}.${key}`, seen, budget, depth + 1);
    }
  }
  seen.delete(value);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_EDGE_STRING_BYTES) {
    fail(path, `must not exceed ${MAX_EDGE_STRING_BYTES} UTF-8 bytes`);
  }
  return value;
}

function requiredIdentity(value: unknown, path: string): string {
  const identity = requiredString(value, path);
  if (identity !== identity.trim()) fail(path, "must not have surrounding whitespace");
  if (Buffer.byteLength(identity, "utf8") > MAX_EDGE_IDENTITY_BYTES) {
    fail(path, `must not exceed ${MAX_EDGE_IDENTITY_BYTES} UTF-8 bytes`);
  }
  return identity;
}

function validateSchemaNode(value: unknown, path: string, depth: number): void {
  if (typeof value === "boolean") return;
  const record = asRecord(value, path);
  if (record.type !== undefined) {
    const allowed = ["array", "boolean", "integer", "null", "number", "object", "string"];
    const types = Array.isArray(record.type) ? record.type : [record.type];
    if (types.length === 0
      || types.some((item) => typeof item !== "string" || !allowed.includes(item))
      || new Set(types).size !== types.length) {
      fail(`${path}.type`, "must be one type or an array of unique JSON Schema types");
    }
  }
  if (record.properties !== undefined) {
    const properties = asRecord(record.properties, `${path}.properties`);
    for (const [key, schema] of Object.entries(properties)) {
      validateSchemaNode(schema, `${path}.properties.${key}`, depth + 1);
    }
  }
  if (record.required !== undefined) {
    if (!Array.isArray(record.required)
      || record.required.some((item) => typeof item !== "string")
      || new Set(record.required).size !== record.required.length) {
      fail(`${path}.required`, "must be an array of unique strings");
    }
  }
  if (record.additionalProperties !== undefined
    && typeof record.additionalProperties !== "boolean") {
    validateSchemaNode(record.additionalProperties, `${path}.additionalProperties`, depth + 1);
  }
  if (record.items !== undefined) {
    if (Array.isArray(record.items)) {
      record.items.forEach((item, index) => validateSchemaNode(item, `${path}.items[${index}]`, depth + 1));
    } else {
      validateSchemaNode(record.items, `${path}.items`, depth + 1);
    }
  }
  if (depth > MAX_EDGE_JSON_DEPTH) fail(path, `must not exceed JSON depth ${MAX_EDGE_JSON_DEPTH}`);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, path);
}

function optionalContentHash(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const hash = requiredString(value, path);
  if (!HASH_PATTERN.test(hash)) fail(path, "must be a lowercase sha256 digest");
  return hash;
}

function optionalBody(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(path, "must be a string");
  if (Buffer.byteLength(value, "utf8") > MAX_EDGE_CONTEXT_BODY_BYTES) {
    fail(path, `must not exceed ${MAX_EDGE_CONTEXT_BODY_BYTES} UTF-8 bytes`);
  }
  return value;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(path: string, message: string): never {
  throw new EdgeContractError(path, message);
}
