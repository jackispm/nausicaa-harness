import type {
  ModelCapabilities,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "../domain/ports.js";

/**
 * Detached model facts captured at one request boundary.
 *
 * Capabilities are advisory metadata.  They are copied so a provider-owned
 * catalog cannot change while the prepared call is in flight.
 */
export interface PreparedModelSnapshot {
  readonly model: string;
  readonly capabilities?: Readonly<ModelCapabilities>;
}

/**
 * A request plus the provider method bindings captured for one dispatch.
 *
 * The request is deeply frozen except for the caller-owned AbortSignal, whose
 * identity and mutability are intentionally preserved for cancellation.
 */
export interface PreparedModelCall {
  readonly request: Readonly<ModelRequest>;
  readonly snapshot: PreparedModelSnapshot;
  /** Convenience aliases for consumers that only need the bound metadata. */
  readonly model: string;
  readonly capabilities?: Readonly<ModelCapabilities>;
  readonly complete: () => Promise<ModelResponse>;
  readonly stream?: () => AsyncIterable<ModelStreamEvent>;
}

export interface PreparedModelOptions {
  /**
   * Reuse capability metadata already read for the same request boundary.
   * Presence of this property is significant: `undefined` means the
   * delegate has no capability snapshot, so it must not be probed again.
   */
  readonly capabilities?: ModelCapabilities | undefined;
}

export interface PreparedModelPortOptions {
  /** Auxiliary lanes can skip advisory catalog reads when they do not use them. */
  readonly captureCapabilities?: boolean;
}

/**
 * Generic request-boundary decorator for ModelPort implementations.
 *
 * It does not inspect, copy, or resolve credentials.  A fresh immutable
 * request and capability snapshot is captured before each complete/stream
 * dispatch, and the delegate methods used by that dispatch are bound at the
 * same point so later delegate property changes cannot retarget the call.
 */
export class PreparedModelPort implements ModelPort {
  readonly capabilities?: (model: string) => ModelCapabilities;
  readonly stream?: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;
  private readonly shouldCaptureCapabilities: boolean;

  constructor(
    private readonly delegate: ModelPort,
    options: PreparedModelPortOptions = {},
  ) {
    this.shouldCaptureCapabilities = options.captureCapabilities ?? true;
    if (delegate.capabilities !== undefined) {
      this.capabilities = (model) => snapshotCapabilities(
        delegate.capabilities!.call(delegate, model),
      );
    }
    if (delegate.stream !== undefined) {
      this.stream = (request) => {
        const prepared = this.prepare(request);
        return prepared.stream!();
      };
    }
  }

  /** Capture one immutable request, model identity, and advisory capabilities. */
  prepare(request: ModelRequest, options?: PreparedModelOptions): PreparedModelCall {
    const preparedRequest = snapshotModelRequest(request);
    const capabilities = options !== undefined && Object.hasOwn(options, "capabilities")
      ? options.capabilities === undefined
        ? undefined
        : snapshotCapabilities(options.capabilities)
      : this.shouldCaptureCapabilities
        ? this.captureCapabilities(preparedRequest.model)
        : undefined;
    const snapshot: PreparedModelSnapshot = Object.freeze({
      model: preparedRequest.model,
      ...(capabilities === undefined ? {} : { capabilities }),
    });
    const complete = this.delegate.complete.bind(this.delegate);
    const stream = this.delegate.stream?.bind(this.delegate);
    const prepared: PreparedModelCall = {
      request: preparedRequest,
      snapshot,
      model: snapshot.model,
      ...(snapshot.capabilities === undefined ? {} : { capabilities: snapshot.capabilities }),
      complete: () => complete(preparedRequest),
      ...(stream === undefined ? {} : { stream: () => stream(preparedRequest) }),
    };
    return Object.freeze(prepared);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.prepare(request).complete();
  }

  private captureCapabilities(model: string): Readonly<ModelCapabilities> | undefined {
    const resolve = this.delegate.capabilities;
    if (resolve === undefined) return undefined;
    try {
      return snapshotCapabilities(resolve.call(this.delegate, model));
    } catch {
      // Capabilities are optional/advisory on ModelPort.  A capability probe
      // must not turn a historically valid complete/stream request into a
      // failure merely because the provider cannot answer it locally.
      return undefined;
    }
  }
}

/** Construct a request-boundary decorator without exposing provider internals. */
export function prepareModelPort(
  delegate: ModelPort,
  options: PreparedModelPortOptions = {},
): PreparedModelPort {
  return new PreparedModelPort(delegate, options);
}

/**
 * Clone and deeply freeze provider-visible request data while retaining the
 * exact AbortSignal object supplied by the caller.
 */
export function snapshotModelRequest(request: ModelRequest): Readonly<ModelRequest> {
  const snapshot: ModelRequest = {
    ...request,
    messages: structuredClone(request.messages),
    tools: structuredClone(request.tools),
  };
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== "signal") deepFreeze(value);
  }
  return Object.freeze(snapshot);
}

function snapshotCapabilities(value: ModelCapabilities): Readonly<ModelCapabilities> {
  const snapshot = structuredClone(value);
  return deepFreeze(snapshot) as Readonly<ModelCapabilities>;
}

function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
