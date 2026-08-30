/** Protocol version for the narrow daemon service identity probe. */
export const DAEMON_SERVICE_PROBE_VERSION = 1 as const;

const MAX_IDENTITY_LENGTH = 256;

export interface DaemonServiceProbeRequest {
  readonly version: typeof DAEMON_SERVICE_PROBE_VERSION;
  readonly controlProtocolVersion: number;
  readonly instanceToken: string;
  readonly socketPath: string;
  readonly timeoutMs: number;
}

export interface DaemonServiceProbeResponse {
  readonly version: typeof DAEMON_SERVICE_PROBE_VERSION;
  readonly controlProtocolVersion: number;
  readonly instanceToken: string;
  readonly state: "ready" | "draining";
}

/**
 * A transport must distinguish a confirmed absent listener from failures for
 * which liveness is unknown. Stale socket cleanup is allowed only for the
 * former result.
 */
export type DaemonServiceProbeTransportResult =
  | { readonly status: "response"; readonly response: unknown }
  | { readonly status: "unavailable" }
  | { readonly status: "error"; readonly error?: unknown };

export type DaemonServiceProbePort = (
  request: DaemonServiceProbeRequest,
) => Promise<DaemonServiceProbeTransportResult>;

export type DaemonServiceProbeResult =
  | { readonly status: "ready"; readonly state: "ready" | "draining" }
  | { readonly status: "unavailable" }
  | { readonly status: "mismatch"; readonly reason: "malformed" | "protocol" | "instance" }
  | { readonly status: "error"; readonly error?: unknown };

export interface ProbeDaemonServiceOptions {
  readonly probe: DaemonServiceProbePort;
  readonly controlProtocolVersion: number;
  readonly instanceToken: string;
  readonly socketPath: string;
  readonly timeoutMs: number;
}

/** Run one bounded transport probe and prove protocol plus instance identity. */
export async function probeDaemonService(
  options: ProbeDaemonServiceOptions,
): Promise<DaemonServiceProbeResult> {
  validateProbeOptions(options);
  let transport: DaemonServiceProbeTransportResult;
  try {
    transport = await withTimeout(
      options.probe({
        version: DAEMON_SERVICE_PROBE_VERSION,
        controlProtocolVersion: options.controlProtocolVersion,
        instanceToken: options.instanceToken,
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs,
      }),
      options.timeoutMs,
    );
  } catch (error: unknown) {
    return { status: "error", error };
  }

  if (transport === null || typeof transport !== "object" || Array.isArray(transport)) {
    return { status: "mismatch", reason: "malformed" };
  }
  if (transport.status === "unavailable") return { status: "unavailable" };
  if (transport.status === "error") return { status: "error", error: transport.error };
  if (transport.status !== "response") {
    return { status: "mismatch", reason: "malformed" };
  }

  const response = decodeProbeResponse(transport.response);
  if (response === undefined) return { status: "mismatch", reason: "malformed" };
  if (response.controlProtocolVersion !== options.controlProtocolVersion) {
    return { status: "mismatch", reason: "protocol" };
  }
  if (response.instanceToken !== options.instanceToken) {
    return { status: "mismatch", reason: "instance" };
  }
  return { status: "ready", state: response.state };
}

function decodeProbeResponse(value: unknown): DaemonServiceProbeResponse | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, [
    "version",
    "controlProtocolVersion",
    "instanceToken",
    "state",
  ])) {
    return undefined;
  }
  if (
    record.version !== DAEMON_SERVICE_PROBE_VERSION
    || !isPositiveSafeInteger(record.controlProtocolVersion)
    || !isOpaqueIdentity(record.instanceToken)
    || (record.state !== "ready" && record.state !== "draining")
  ) {
    return undefined;
  }
  return record as unknown as DaemonServiceProbeResponse;
}

function validateProbeOptions(options: ProbeDaemonServiceOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("probe options must be an object");
  }
  if (typeof options.probe !== "function") throw new TypeError("probe must be a function");
  if (!isPositiveSafeInteger(options.controlProtocolVersion)) {
    throw new TypeError("controlProtocolVersion must be a positive safe integer");
  }
  if (!isOpaqueIdentity(options.instanceToken)) {
    throw new TypeError("instanceToken must be a bounded opaque identity");
  }
  if (
    typeof options.socketPath !== "string"
    || options.socketPath.length === 0
    || options.socketPath.includes("\0")
  ) {
    throw new TypeError("socketPath must be a non-empty path without NUL");
  }
  if (!isPositiveSafeInteger(options.timeoutMs) || options.timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be between 1 and 60000");
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOpaqueIdentity(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= MAX_IDENTITY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("daemon service probe timed out")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
