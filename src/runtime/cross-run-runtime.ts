import type {
  CrossRunEndpoint,
  CrossRunRelationship,
  Visibility,
} from "../domain/types.js";
import type { ContentAddressedStore } from "../store/index.js";
import type { Ledger } from "../ledger/index.js";
import {
  CrossRunRouter,
  type CrossRunRouterOptions,
} from "../a2a/cross-run-router.js";
import {
  LedgerCrossRunFactStore,
} from "../a2a/cross-run-adapter.js";
import {
  normalizeSenderIdentity,
  type CrossRunSenderIdentity,
} from "../a2a/cross-run-contract.js";
import {
  createAgentMessageTool,
  type AgentMessageToolOptions,
  type AgentMessageToolPermissions,
} from "./agent-message-tool.js";
import type { MoweAgentTool } from "../mowe/types.js";

/** Context available to a host-owned sender factory after the Run is known. */
export interface CrossRunRuntimeSenderContext {
  readonly runId: string;
  readonly laneId: string;
  /** Host-owned process/session identity for this activation, when available. */
  readonly sessionId?: string;
  readonly workspace: string;
  /** The source Ledger is the default durable outbox boundary. */
  readonly ledger: Ledger;
  readonly store: ContentAddressedStore;
}

export type CrossRunRuntimeSenderFactory = (
  context: CrossRunRuntimeSenderContext,
) => CrossRunSenderIdentity | Promise<CrossRunSenderIdentity>;

/**
 * Host composition for Main's cross-Run A2A capability.
 *
 * A fully composed router may be supplied by a daemon/topology host. For
 * local composition, `routerOptions` is enough: the runtime binds the source
 * Run's Ledger as the durable outbox while the host still supplies target
 * resolution, roster, authorization, admission, relay and wake adapters.
 * Nothing is inferred from filesystem paths or model input.
 */
export interface CrossRunRuntimeComposition {
  /** Existing host-owned router; mutually exclusive with routerOptions. */
  readonly router?: Pick<CrossRunRouter, "send">;
  /** Router ports and policy. A source Ledger store is supplied by default. */
  readonly routerOptions?: CrossRunRouterOptions;
  /** Authenticated sender identity, or a factory once the Run ID is known. */
  readonly sender: CrossRunSenderIdentity | CrossRunRuntimeSenderFactory;
  /** Optional Mowe/agent-message scope fixed by the host. */
  readonly permissions?: AgentMessageToolPermissions | readonly CrossRunRelationship[];
  readonly workspaceId?: string;
  readonly executionWorkspace?: string;
  readonly workspace?: string;
  readonly conversationId?: string;
  readonly threadId?: string;
  readonly correlationId?: string;
  readonly visibility?: Visibility;
  readonly priority?: number;
}

export class CrossRunRuntimeCompositionError extends Error {
  override readonly name = "CrossRunRuntimeCompositionError";
}

/** Build the host-bound `agent_message` capability for one Main Run. */
export async function createCrossRunRuntimeTool(
  composition: CrossRunRuntimeComposition,
  context: CrossRunRuntimeSenderContext,
): Promise<MoweAgentTool & { readonly sourceEndpoint: CrossRunEndpoint }> {
  validateComposition(composition);
  if (composition.router !== undefined && composition.routerOptions !== undefined) {
    throw new CrossRunRuntimeCompositionError(
      "cross-Run composition cannot provide both router and routerOptions",
    );
  }
  const senderInput = typeof composition.sender === "function"
    ? await composition.sender(context)
    : composition.sender;
  const sender = normalizeSender(senderInput);
  assertSourceEndpoint(sender.endpoint, context);
  const router = composition.router ?? createRouter(composition.routerOptions, sender.endpoint, context.ledger);
  const options: AgentMessageToolOptions = {
    router,
    sender,
    ...(composition.workspaceId === undefined ? {} : { workspaceId: composition.workspaceId }),
    executionWorkspace: composition.executionWorkspace ?? composition.workspace ?? context.workspace,
    ...(composition.permissions === undefined ? {} : { permissions: composition.permissions }),
    ...(composition.conversationId === undefined ? {} : { conversationId: composition.conversationId }),
    ...(composition.threadId === undefined ? {} : { threadId: composition.threadId }),
    ...(composition.correlationId === undefined ? {} : { correlationId: composition.correlationId }),
    ...(composition.visibility === undefined ? {} : { visibility: composition.visibility }),
    ...(composition.priority === undefined ? {} : { priority: composition.priority }),
  };
  const tool = createAgentMessageTool(options);
  return Object.freeze({
    ...tool,
    sourceEndpoint: Object.freeze({ ...sender.endpoint }),
  });
}

function createRouter(
  routerOptions: CrossRunRouterOptions | undefined,
  source: CrossRunEndpoint,
  ledger: Ledger,
): CrossRunRouter {
  const options = routerOptions ?? {};
  if (options.factStore === undefined && options.factStoreFor === undefined) {
    return new CrossRunRouter({
      ...options,
      factStore: new LedgerCrossRunFactStore({ ledger, source }),
    });
  }
  return new CrossRunRouter(options);
}

function validateComposition(value: CrossRunRuntimeComposition): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CrossRunRuntimeCompositionError(
      "cross-Run composition must be an object",
    );
  }
  if (value.router === undefined && value.routerOptions === undefined) {
    throw new CrossRunRuntimeCompositionError(
      "cross-Run composition requires a router or routerOptions",
    );
  }
  if (typeof value.sender !== "function"
    && (value.sender === null || typeof value.sender !== "object")) {
    throw new CrossRunRuntimeCompositionError(
      "cross-Run composition requires an authenticated sender",
    );
  }
}

function normalizeSender(value: CrossRunSenderIdentity): CrossRunSenderIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CrossRunRuntimeCompositionError(
      "cross-Run sender factory returned an invalid identity",
    );
  }
  try {
    return normalizeSenderIdentity(value);
  } catch {
    throw new CrossRunRuntimeCompositionError(
      "cross-Run sender factory returned an invalid identity",
    );
  }
}

function assertSourceEndpoint(
  endpoint: CrossRunEndpoint,
  context: CrossRunRuntimeSenderContext,
): void {
  if (endpoint.runId !== context.runId || endpoint.laneId !== context.laneId) {
    throw new CrossRunRuntimeCompositionError(
      "cross-Run sender endpoint does not match the active Run lane",
    );
  }
}
