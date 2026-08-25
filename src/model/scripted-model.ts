import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
} from "../domain/ports.js";

export type ScriptedModelStep =
  | ModelResponse
  | Error
  | ((
      request: ModelRequest,
      callIndex: number,
    ) => ModelResponse | Promise<ModelResponse>);

/** Deterministic model boundary for protocol and recovery tests. */
export class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly steps: ScriptedModelStep[];

  constructor(steps: readonly ScriptedModelStep[]) {
    this.steps = [...steps];
  }

  get callCount(): number {
    return this.requests.length;
  }

  get pendingCount(): number {
    return this.steps.length;
  }

  append(...steps: readonly ScriptedModelStep[]): void {
    this.steps.push(...steps);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    throwIfAborted(request.signal);

    const callIndex = this.requests.length;
    this.requests.push(copyRequest(request));
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error(`ScriptedModel has no response for call ${callIndex + 1}`);
    }
    if (step instanceof Error) {
      throw step;
    }

    const pending =
      typeof step === "function" ? Promise.resolve(step(request, callIndex)) : Promise.resolve(step);
    const response = await withAbort(pending, request.signal);
    return structuredClone(response);
  }
}

function copyRequest(request: ModelRequest): ModelRequest {
  return {
    ...request,
    messages: structuredClone(request.messages),
    tools: structuredClone(request.tools),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

async function withAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return pending;
  }
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
