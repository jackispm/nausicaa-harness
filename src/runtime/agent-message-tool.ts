import type { AgentTool, ToolExecutionContext, ToolResult } from "../domain/ports.js";
import type {
  ArtifactRef,
  CrossRunEndpoint,
  CrossRunReceipt,
  CrossRunRelationship,
  Visibility,
} from "../domain/types.js";
import { annotateTool } from "../mowe/catalog.js";
import type { MoweAgentTool } from "../mowe/types.js";
import {
  CrossRunProtocolError,
  type CrossRunProtocolErrorCode,
  type CrossRunSenderIdentity,
  type CrossRunSendRequest,
  type CrossRunTargetSelector,
  normalizeSenderIdentity,
  normalizeTarget,
} from "../a2a/cross-run-contract.js";
import type { CrossRunRouter } from "../a2a/cross-run-router.js";

const TOOL_NAME = "agent_message";
const TOOL_VERSION = "1";
const MAX_BOUND_STRING_LENGTH = 4_096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const RELATIONSHIPS = ["parent", "sibling", "child", "direct"] as const;
const VISIBILITIES = ["lane", "run", "user", "sensitive"] as const;

const ARGUMENT_KEYS = new Set([
  "target",
  "payload",
  "text",
  "conversationId",
  "threadId",
  "idempotencyKey",
  "correlationId",
  "visibility",
  "priority",
  "createdAt",
  "expiresAt",
  "artifactRefs",
  "causationId",
]);

/** Target selectors exposed to the model never contain a workspace endpoint. */
export type AgentMessageTarget =
  | { readonly relationship: "parent" }
  | {
      readonly relationship: "sibling" | "child" | "direct";
      readonly name?: string;
      readonly id?: string;
    };

/**
 * The model owns message content and bounded request metadata only. Sender,
 * source workspace, and permission grants remain host-owned; metadata values
 * are checked against those grants before routing.
 */
export interface AgentMessageToolArguments {
  readonly target: AgentMessageTarget;
  /** Typed wire payload. Omit this when using the plain-message shorthand. */
  readonly payload?: CrossRunSendRequest["payload"];
  /** Compatibility shorthand for a `message.inform` payload. */
  readonly text?: string;
  readonly conversationId?: string;
  readonly threadId?: string;
  /** Defaults to the Mowe operation id, preserving retries of the same call. */
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly visibility?: Visibility;
  readonly priority?: number;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly causationId?: string;
}

export interface AgentMessageToolPermissions {
  /** Additional relationship allow-list applied before the router. */
  readonly relationships?: readonly CrossRunRelationship[];
  /** Alias accepted by host composition code. */
  readonly allowedRelationships?: readonly CrossRunRelationship[];
  /** Message visibility values the host has granted to this tool. */
  readonly visibilities?: readonly Visibility[];
  /** Alias accepted by host composition code. */
  readonly allowedVisibilities?: readonly Visibility[];
  /** Optional host-owned priority ceiling. */
  readonly maxPriority?: number;
}

export interface AgentMessageToolOptions {
  readonly router: Pick<CrossRunRouter, "send">;
  /** Authenticated attach/worker identity. It is snapshotted by the factory. */
  readonly sender: CrossRunSenderIdentity;
  /** Optional endpoint workspace assertion; it is never model-controlled. */
  readonly workspaceId?: string;
  /** Optional exact Mowe workspace binding for defense against tool reuse. */
  readonly executionWorkspace?: string;
  /** Alias for executionWorkspace used by host composition. */
  readonly workspace?: string;
  /** Host-owned relationship/visibility limits. */
  readonly permissions?: AgentMessageToolPermissions | readonly CrossRunRelationship[];
  /** Host-owned message scope. Defaults are derived from the sender endpoint. */
  readonly conversationId?: string;
  readonly threadId?: string;
  readonly correlationId?: string;
  readonly visibility?: Visibility;
  readonly priority?: number;
}

export type AgentMessageToolReceipt = Omit<CrossRunReceipt, "diagnostic"> & {
  readonly diagnostic?: string;
};

export interface AgentMessageToolFailure {
  readonly status: "error";
  readonly error: {
    readonly code: CrossRunProtocolErrorCode | "cancelled" | "scope-mismatch" | "agent-message-failed";
    readonly message: string;
  };
}

/**
 * Build the Main-facing cross-Run message capability. The returned tool is a
 * normal AgentTool plus Mowe metadata, so the host still controls whether it
 * is admitted for a Turn.
 */
export function createAgentMessageTool(options: AgentMessageToolOptions): MoweAgentTool {
  if (options === null || typeof options !== "object") {
    throw new TypeError("agent message tool options must be an object");
  }
  if (options.router === undefined || typeof options.router.send !== "function") {
    throw new TypeError("agent message router must implement send");
  }

  const sender = normalizeSenderIdentity(options.sender);
  const workspaceId = options.workspaceId === undefined
    ? undefined
    : boundedString(options.workspaceId, "workspaceId");
  if (workspaceId !== undefined && workspaceId !== sender.endpoint.workspaceId) {
    throw new CrossRunProtocolError("sender workspace does not match the bound workspace", "identity-forged");
  }
  const requestedExecutionWorkspace = options.executionWorkspace ?? options.workspace;
  if (options.executionWorkspace !== undefined && options.workspace !== undefined
    && options.executionWorkspace !== options.workspace) {
    throw new TypeError("executionWorkspace and workspace must match when both are supplied");
  }
  const executionWorkspace = requestedExecutionWorkspace === undefined
    ? undefined
    : boundedString(requestedExecutionWorkspace, "executionWorkspace");
  const conversationId = boundedString(
    options.conversationId ?? sender.endpoint.runId,
    "conversationId",
  );
  const threadId = boundedString(
    options.threadId
      ?? `a2a:${sender.endpoint.sessionId}:${sender.endpoint.runId}:${sender.endpoint.laneId}`,
    "threadId",
  );
  const correlationId = options.correlationId === undefined
    ? undefined
    : boundedString(options.correlationId, "correlationId");
  const visibility = normalizeVisibility(options.visibility ?? "run");
  const priority = normalizePriority(options.priority ?? 0);
  const permissions = withDefaultMessageScope(
    normalizePermissions(options.permissions),
    visibility,
    priority,
  );
  const senderWithPermissions = applyPermissions(sender, permissions);

  const tool: AgentTool = {
    definition: {
      name: TOOL_NAME,
      description: "Send one message to an explicitly selected parent, sibling, child, or directly reachable agent. For a normal note, use the simple `text` field (for example {target:{relationship:'direct',id:'run-id'},text:'Please inspect this repository'}). Use `payload` only for typed A2A messages: message.inform has {type:'message.inform',text:'...'}; task.request requires a structured goal object and budget object. Sender identity and permissions are fixed by the host; queued is a delivery receipt, not proof the message was handled.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "object",
            description: "Family/direct selector from the host-provided reachable roster; wildcards are not supported",
            properties: {
              relationship: {
                type: "string",
                enum: ["parent", "sibling", "child", "direct"],
              },
              name: { type: "string", minLength: 1, maxLength: 512 },
              id: { type: "string", minLength: 1, maxLength: 512 },
            },
            required: ["relationship"],
            additionalProperties: false,
          },
          payload: {
            ...payloadSchema(),
            description: "Typed A2A payload. Prefer the top-level text shorthand for a plain message. Do not combine text and payload.",
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BOUND_STRING_LENGTH,
            description: "Plain message shorthand; normalized to payload {type:'message.inform',text}. Mutually exclusive with payload.",
          },
          conversationId: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BOUND_STRING_LENGTH,
          },
          threadId: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BOUND_STRING_LENGTH,
          },
          idempotencyKey: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BOUND_STRING_LENGTH,
            description: "Optional stable retry key; omitted uses this tool operation's stable id",
          },
          correlationId: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BOUND_STRING_LENGTH,
          },
          visibility: {
            type: "string",
            enum: ["lane", "run", "user", "sensitive"],
          },
          priority: { type: "integer", minimum: 0, maximum: 100 },
          createdAt: { type: "string", minLength: 1, maxLength: 128 },
          expiresAt: { type: "string", minLength: 1, maxLength: 128 },
          artifactRefs: {
            type: "array",
            maxItems: 128,
            items: artifactRefSchema(),
            description: "Content-addressed artifact references; filesystem paths are not accepted",
          },
          causationId: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BOUND_STRING_LENGTH,
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },

    async execute(arguments_, context): Promise<ToolResult> {
      try {
        assertExecutionScope(context, senderWithPermissions.endpoint, executionWorkspace);
        assertArgumentKeys(arguments_);
        if (context.signal?.aborted === true) {
          return failure("cancelled", "Agent message delivery was cancelled");
        }

        const target = modelTarget(arguments_.target);
        const requestVisibility = arguments_.visibility === undefined
          ? visibility
          : normalizeVisibility(arguments_.visibility);
        const requestPriority = arguments_.priority === undefined
          ? priority
          : normalizePriority(arguments_.priority);
        assertMessagePermission(target.relationship, requestVisibility, requestPriority, permissions);
        const request: CrossRunSendRequest = {
          target,
          payload: normalizeMessagePayload(arguments_),
          conversationId: arguments_.conversationId === undefined
            ? conversationId
            : boundedString(arguments_.conversationId, "conversationId"),
          threadId: arguments_.threadId === undefined
            ? threadId
            : boundedString(arguments_.threadId, "threadId"),
          correlationId: arguments_.correlationId === undefined
            ? correlationId ?? boundedString(context.operationId, "operationId")
            : boundedString(arguments_.correlationId, "correlationId"),
          idempotencyKey: arguments_.idempotencyKey === undefined
            ? `agent-message:${boundedString(context.operationId, "operationId")}`
            : boundedString(arguments_.idempotencyKey, "idempotencyKey"),
          visibility: requestVisibility,
          priority: requestPriority,
          ...(arguments_.createdAt === undefined
            ? {}
            : { createdAt: boundedString(arguments_.createdAt, "createdAt") }),
          ...(arguments_.expiresAt === undefined
            ? {}
            : { expiresAt: boundedString(arguments_.expiresAt, "expiresAt") }),
          ...(arguments_.artifactRefs === undefined
            ? {}
            : { artifactRefs: arguments_.artifactRefs as readonly ArtifactRef[] }),
          ...(arguments_.causationId === undefined
            ? {}
            : { causationId: boundedString(arguments_.causationId, "causationId") }),
        };
        const receipt = await options.router.send(request, senderWithPermissions);
        const projected = safeReceipt(receipt);
        return {
          content: JSON.stringify(projected),
          isError: isFailureReceipt(projected.status),
        };
      } catch (error: unknown) {
        if (error instanceof CrossRunProtocolError) {
          return failure(error.code, safeProtocolMessage(error.code));
        }
        if (error instanceof AgentMessageScopeError) {
          return failure("scope-mismatch", "Agent message tool is bound to a different Run or workspace");
        }
        return failure("agent-message-failed", "Agent message delivery failed");
      }
    },
  };

  return annotateTool(tool, {
    effect: "external",
    version: TOOL_VERSION,
    deterministic: false,
    supportsBatch: false,
    concurrencySafe: false,
    supportsStreaming: false,
    requiresApproval: false,
    scope: "run",
    inputKinds: ["json", "artifact"],
    outputKinds: ["json"],
  });
}

/** Naming alias for hosts that describe this capability by transport scope. */
export const createCrossRunMessageTool = createAgentMessageTool;

function modelTarget(value: unknown): CrossRunTargetSelector {
  if (!isRecord(value)) {
    throw new CrossRunProtocolError("target must be an object", "selector-invalid");
  }
  if ("endpoint" in value || "workspaceId" in value || "sessionId" in value
    || "runId" in value || "laneId" in value) {
    throw new CrossRunProtocolError(
      "agent_message target cannot choose an endpoint or workspace",
      "selector-invalid",
    );
  }
  return normalizeTarget(value);
}

function assertArgumentKeys(value: Record<string, unknown>): void {
  if (!isRecord(value)) {
    throw new CrossRunProtocolError("agent_message arguments must be an object", "invalid-request");
  }
  for (const key of Object.keys(value)) {
    if (!ARGUMENT_KEYS.has(key)) {
      throw new CrossRunProtocolError(`agent_message argument ${key} is not allowed`);
    }
  }
}

interface NormalizedAgentMessagePermissions {
  readonly relationships?: readonly CrossRunRelationship[];
  readonly visibilities?: readonly Visibility[];
  readonly maxPriority?: number;
}

function withDefaultMessageScope(
  permissions: NormalizedAgentMessagePermissions,
  defaultVisibility: Visibility,
  defaultPriority: number,
): NormalizedAgentMessagePermissions {
  // Factory-level scope is a host boundary, not merely a UI default. A host
  // can explicitly widen it through `permissions`, but an omitted permission
  // object must not let model arguments silently raise visibility or priority.
  return Object.freeze({
    ...(permissions.relationships === undefined ? {} : { relationships: permissions.relationships }),
    visibilities: permissions.visibilities ?? Object.freeze([defaultVisibility]),
    maxPriority: permissions.maxPriority ?? defaultPriority,
  });
}

function normalizePermissions(
  value: AgentMessageToolPermissions | readonly CrossRunRelationship[] | undefined,
): NormalizedAgentMessagePermissions {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    return { relationships: normalizeRelationshipList(value, "permissions") };
  }
  if (!isRecord(value)) throw new TypeError("permissions must be an object or relationship list");
  const relationships = coalescePermissionList<CrossRunRelationship>(
    value.relationships,
    value.allowedRelationships,
    "relationships",
    RELATIONSHIPS,
  );
  const visibilities = coalescePermissionList<Visibility>(
    value.visibilities,
    value.allowedVisibilities,
    "visibilities",
    VISIBILITIES,
  );
  const maxPriority = value.maxPriority === undefined
    ? undefined
    : normalizePriority(value.maxPriority);
  return Object.freeze({
    ...(relationships === undefined ? {} : { relationships }),
    ...(visibilities === undefined ? {} : { visibilities }),
    ...(maxPriority === undefined ? {} : { maxPriority }),
  });
}

function coalescePermissionList<T extends CrossRunRelationship | Visibility>(
  primary: unknown,
  alias: unknown,
  field: string,
  allowed: readonly T[],
): readonly T[] | undefined {
  if (primary !== undefined && alias !== undefined) {
    const left = normalizePermissionValues<T>(primary, field, allowed);
    const right = normalizePermissionValues<T>(alias, `${field} alias`, allowed);
    if (left.length !== right.length || left.some((item, index) => item !== right[index])) {
      throw new TypeError(`${field} and its alias must match`);
    }
    return left;
  }
  if (primary !== undefined) return normalizePermissionValues<T>(primary, field, allowed);
  if (alias !== undefined) return normalizePermissionValues<T>(alias, `${field} alias`, allowed);
  return undefined;
}

function normalizePermissionValues<T extends CrossRunRelationship | Visibility>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): readonly T[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const result: T[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      throw new TypeError(`${field}[${index}] is invalid`);
    }
    if (!result.includes(item as T)) result.push(item as T);
  }
  return Object.freeze(result);
}

function normalizeRelationshipList(
  value: readonly CrossRunRelationship[],
  field: string,
): readonly CrossRunRelationship[] {
  return normalizePermissionValues<CrossRunRelationship>(value, field, RELATIONSHIPS);
}

function applyPermissions(
  sender: CrossRunSenderIdentity,
  permissions: NormalizedAgentMessagePermissions,
): CrossRunSenderIdentity {
  if (permissions.relationships === undefined) return sender;
  const existing = sender.relationshipGrants;
  const grants = existing === undefined
    ? permissions.relationships
    : permissions.relationships.filter((relationship) => existing.includes(relationship));
  return Object.freeze({
    endpoint: structuredClone(sender.endpoint),
    proof: structuredClone(sender.proof),
    relationshipGrants: Object.freeze([...grants]),
  });
}

function assertMessagePermission(
  relationship: CrossRunRelationship,
  visibility: Visibility,
  priority: number,
  permissions: NormalizedAgentMessagePermissions,
): void {
  if (permissions.relationships !== undefined && !permissions.relationships.includes(relationship)) {
    throw new CrossRunProtocolError("agent message relationship is not permitted", "authorization-denied");
  }
  if (permissions.visibilities !== undefined && !permissions.visibilities.includes(visibility)) {
    throw new CrossRunProtocolError("agent message visibility is not permitted", "authorization-denied");
  }
  if (permissions.maxPriority !== undefined && priority > permissions.maxPriority) {
    throw new CrossRunProtocolError("agent message priority is not permitted", "authorization-denied");
  }
}

function assertExecutionScope(
  context: ToolExecutionContext,
  endpoint: CrossRunEndpoint,
  executionWorkspace: string | undefined,
): void {
  if (context.runId !== endpoint.runId
    || (executionWorkspace !== undefined && context.workspace !== executionWorkspace)) {
    throw new AgentMessageScopeError();
  }
}

class AgentMessageScopeError extends Error {
  override readonly name = "AgentMessageScopeError";
}

function safeReceipt(receipt: CrossRunReceipt): AgentMessageToolReceipt {
  const diagnostic = safeDiagnostic(receipt.diagnostic);
  return {
    protocolVersion: receipt.protocolVersion,
    receiptId: receipt.receiptId,
    routeId: receipt.routeId,
    messageId: receipt.messageId,
    idempotencyKey: receipt.idempotencyKey,
    source: endpointReceipt(receipt.source),
    target: endpointReceipt(receipt.target),
    relationship: receipt.relationship,
    status: receipt.status,
    recordedAt: receipt.recordedAt,
    ...(receipt.targetMessageId === undefined ? {} : { targetMessageId: receipt.targetMessageId }),
    ...(receipt.attemptId === undefined ? {} : { attemptId: receipt.attemptId }),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
    ...(receipt.retryAt === undefined ? {} : { retryAt: receipt.retryAt }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function endpointReceipt(endpoint: CrossRunEndpoint): CrossRunEndpoint {
  return {
    workspaceId: endpoint.workspaceId,
    sessionId: endpoint.sessionId,
    runId: endpoint.runId,
    laneId: endpoint.laneId,
  };
}

function safeDiagnostic(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value)
    ? value
    : "delivery-diagnostic-redacted";
}

function isFailureReceipt(status: CrossRunReceipt["status"]): boolean {
  return status === "expired"
    || status === "rejected"
    || status === "uncertain"
    || status === "conflict";
}

function failure(code: AgentMessageToolFailure["error"]["code"], message: string): ToolResult {
  const content: AgentMessageToolFailure = {
    status: "error",
    error: { code, message },
  };
  return { content: JSON.stringify(content), isError: true };
}

function safeProtocolMessage(code: CrossRunProtocolErrorCode): string {
  switch (code) {
    case "invalid-request":
      return "Agent message request was rejected: use text for a plain note, or a typed payload with all required fields";
    case "selector-invalid":
      return "Agent message target is invalid: select one reachable agent with relationship and id or name";
    case "selector-ambiguous":
      return "Agent message target is ambiguous: select one reachable agent by its exact id";
    case "artifact-invalid":
    case "artifact-mismatch":
    case "artifact-integrity":
    case "expired":
    case "idempotency-conflict":
      return "Agent message request was rejected";
    case "identity-forged":
    case "authorization-denied":
    case "cross-workspace-denied":
      return "Agent message authorization was denied";
    case "capacity-rejected":
    case "rate-limited":
      return "Agent message admission is temporarily unavailable";
    case "target-unavailable":
    case "target-admission-failed":
    case "wake-failed":
    case "durable-fact-failed":
    case "uncertain-side-effect":
      return "Agent message delivery could not be confirmed";
  }
}

function boundedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0
    || value.length > MAX_BOUND_STRING_LENGTH || CONTROL_CHARACTER.test(value)) {
    throw new TypeError(`${field} must be a bounded string without control characters`);
  }
  return value;
}

/** Normalize the ergonomic plain-message form into the typed wire payload. */
function normalizeMessagePayload(
  value: Record<string, unknown>,
): CrossRunSendRequest["payload"] {
  const payload = value.payload;
  const text = value.text;
  if (payload !== undefined && text !== undefined) {
    throw new CrossRunProtocolError(
      "agent_message accepts either text or payload, not both",
      "invalid-request",
    );
  }
  if (payload !== undefined) {
    if (!isRecord(payload)) {
      throw new CrossRunProtocolError(
        "agent_message payload must be an object",
        "invalid-request",
      );
    }
    return payload as CrossRunSendRequest["payload"];
  }
  if (text === undefined) {
    throw new CrossRunProtocolError(
      "agent_message requires text or payload",
      "invalid-request",
    );
  }
  return {
    type: "message.inform",
    text: boundedString(text, "text"),
  };
}

function normalizeVisibility(value: unknown): Visibility {
  if (value === "lane" || value === "run" || value === "user" || value === "sensitive") {
    return value;
  }
  throw new TypeError("visibility is invalid");
}

function normalizePriority(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100) {
    throw new TypeError("priority must be a safe integer between 0 and 100");
  }
  return value as number;
}

function payloadSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: [
          "advice.propose",
          "task.request",
          "task.accept",
          "task.result",
          "task.failed",
          "question.ask",
          "question.answer",
          "message.inform",
        ],
      },
      advice: { type: "object" },
      taskId: { type: "string" },
      goal: {
        type: "object",
        description: "Required for task.request: {version:1,statement:string,successCriteria:string[],hardConstraints:string[]}",
        properties: {
          version: { type: "integer", minimum: 1 },
          statement: { type: "string", minLength: 1 },
          successCriteria: { type: "array", items: { type: "string" }, maxItems: 128 },
          hardConstraints: { type: "array", items: { type: "string" }, maxItems: 128 },
        },
        required: ["version", "statement", "successCriteria", "hardConstraints"],
        additionalProperties: false,
      },
      inputRefs: { type: "array", items: artifactRefSchema() },
      budget: {
        type: "object",
        description: "Required for task.request: {maxModelTokens:number,maxWallClockMs:number} with optional deadline/maxAttempts",
        properties: {
          maxModelTokens: { type: "integer", minimum: 1 },
          maxWallClockMs: { type: "integer", minimum: 1 },
          deadline: { type: "string" },
          maxAttempts: { type: "integer", minimum: 1 },
        },
        required: ["maxModelTokens", "maxWallClockMs"],
        additionalProperties: false,
      },
      status: { type: "string", enum: ["completed", "partial"] },
      summary: { type: "string" },
      evidenceRefs: { type: "array", items: { type: "string" } },
      artifactRefs: { type: "array", items: artifactRefSchema() },
      openQuestions: { type: "array", items: { type: "string" } },
      usage: { type: "object" },
      reason: { type: "string" },
      retryable: { type: "boolean" },
      question: { type: "string" },
      answer: { type: "string" },
      text: { type: "string" },
    },
    required: ["type"],
    additionalProperties: false,
  };
}

function artifactRefSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 512 },
      contentHash: {
        type: "string",
        pattern: "^sha256:[0-9a-f]{64}$",
      },
      mediaType: { type: "string", minLength: 1, maxLength: 256 },
      byteLength: { type: "integer", minimum: 0 },
    },
    required: ["id", "contentHash", "mediaType", "byteLength"],
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
