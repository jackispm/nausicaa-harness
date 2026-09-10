import { createHash, randomUUID } from "node:crypto";
import type {
  Advice,
  AdviceKind,
  Clock,
  LaneId,
  ModelPort,
  ObservationFrame,
  RunId,
  TokenUsage,
} from "../domain/index.js";
import { parseSingleJsonObject, systemClock } from "../domain/index.js";
import { prepareModelPort } from "../model/prepared-model.js";

export const TETO_SYSTEM_PROMPT = `You are Teto, an auxiliary observer. Watch for intent drift and better solutions. Stay silent unless you have new, high-value advice. JSON: {"action":"silent"} or {"action":"advise","kind":"orientation|intent-gap|method-alternative","claim":"<=8 words","suggestedAction":"<=8 words","risk":"low|medium|high"}.`;

const ADVICE_TTL_MS = 10 * 60 * 1_000;

export interface IntentNavigatorOptions {
  modelPort: ModelPort;
  model: string;
  laneId?: LaneId;
  clock?: Clock;
  createAdviceId?: () => string;
  maxAdviceOutputTokens?: number;
}

export interface IntentNavigatorRequest {
  runId: RunId;
  sessionId: string;
  frame: ObservationFrame;
  signal?: AbortSignal;
}

export interface IntentNavigatorResult {
  advice?: Advice;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd?: number;
  };
}

export class IntentNavigator {
  private readonly modelPort: ModelPort;
  private readonly model: string;
  private readonly laneId: LaneId;
  private readonly clock: Clock;
  private readonly createAdviceId: () => string;
  private readonly maxAdviceOutputTokens: number;

  constructor(options: IntentNavigatorOptions) {
    this.modelPort = prepareModelPort(options.modelPort, { captureCapabilities: false });
    this.model = options.model;
    this.laneId = options.laneId ?? "teto";
    this.clock = options.clock ?? systemClock;
    this.createAdviceId = options.createAdviceId ?? randomUUID;
    this.maxAdviceOutputTokens = options.maxAdviceOutputTokens ?? 64;
    if (!Number.isSafeInteger(this.maxAdviceOutputTokens) || this.maxAdviceOutputTokens <= 0) {
      throw new RangeError("maxAdviceOutputTokens must be a positive integer");
    }
  }

  async observe(request: IntentNavigatorRequest): Promise<IntentNavigatorResult> {
    const now = this.clock.now();
    const maxOutputTokens = Math.min(
      request.frame.budget.maxOutputTokens,
      this.maxAdviceOutputTokens,
    );
    const response = await this.modelPort.complete({
      runId: request.runId,
      laneId: this.laneId,
      sessionId: request.sessionId,
      model: this.model,
      systemPrompt: TETO_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: JSON.stringify(request.frame),
        createdAt: now.toISOString(),
      }],
      tools: [],
      maxOutputTokens,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (response.stopReason === "aborted") {
      throw new TetoOutputError("Teto response was aborted by the provider", response.usage);
    }
    if (response.stopReason === "length") {
      throw new TetoOutputError(
        `Teto output was truncated at the ${maxOutputTokens}-token limit`,
        response.usage,
      );
    }
    if (response.toolCalls.length !== 0) {
      throw new TetoOutputError("Teto must not request tools", response.usage);
    }
    if (response.usage.output > maxOutputTokens) {
      throw new TetoOutputError(
        `Teto output used ${response.usage.output} tokens; limit is ${maxOutputTokens}`,
        response.usage,
      );
    }

    let advice: Advice | undefined;
    try {
      advice = parseAdviceJson(response.content, {
        adviceId: this.createAdviceId(),
        sourceLane: this.laneId,
        now,
        boundaryId: request.frame.mainDelta.boundaryId,
      });
    } catch (error: unknown) {
      if (error instanceof TetoOutputError) {
        throw new TetoOutputError(error.message, response.usage);
      }
      throw error;
    }
    return {
      ...(advice === undefined ? {} : { advice }),
      usage: response.usage,
    };
  }
}

interface ParseAdviceOptions {
  adviceId: string;
  sourceLane: LaneId;
  now: Date;
  boundaryId: string;
}

const adviceKeys = [
  "action",
  "claim",
  "kind",
  "risk",
  "suggestedAction",
] as const;

export class TetoOutputError extends Error {
  override readonly name = "TetoOutputError";
  readonly usage: TokenUsage | undefined;

  constructor(message: string, usage?: TokenUsage) {
    super(message);
    this.usage = usage === undefined ? undefined : structuredClone(usage);
  }
}

export function parseAdviceJson(
  text: string,
  options: ParseAdviceOptions,
): Advice | undefined {
  let value: unknown;
  try {
    value = parseSingleJsonObject(text);
  } catch {
    throw new TetoOutputError("Teto output must contain a single JSON object");
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new TetoOutputError("Teto output must be a JSON object");
  }

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "action" && value.action === "silent") {
    return undefined;
  }

  const actualKeys = keys.sort();
  if (
    actualKeys.length !== adviceKeys.length
    || actualKeys.some((key, index) => key !== adviceKeys[index])
  ) {
    throw new TetoOutputError("Teto output has missing or unknown fields");
  }
  if (value.action !== "advise") {
    throw new TetoOutputError("Teto action must be silent or advise");
  }

  const kind = enumValue(value.kind, [
    "orientation",
    "intent-gap",
    "method-alternative",
  ] as const, "kind");
  const claim = boundedString(value.claim, "claim", 280);
  const risk = enumValue(value.risk, ["low", "medium", "high"] as const, "risk");
  const suggestedAction = boundedString(
    value.suggestedAction,
    "suggestedAction",
    280,
  );
  const confidence = risk === "high" ? 0.9 : risk === "medium" ? 0.8 : 0.7;
  const urgency = risk === "low" ? "next-turn" : "next-step";
  const expiresAt = new Date(options.now.getTime() + ADVICE_TTL_MS).toISOString();
  const dedupeKey = createHash("sha256")
    .update(JSON.stringify([kind, claim, suggestedAction]))
    .digest("hex")
    .slice(0, 24);

  return {
    adviceId: options.adviceId,
    kind: kind as AdviceKind,
    claim,
    evidenceRefs: [options.boundaryId],
    confidence,
    risk,
    suggestedAction,
    urgency,
    expiresAt,
    dedupeKey,
    sourceLane: options.sourceLane,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TetoOutputError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum) {
    throw new TetoOutputError(`${field} must not exceed ${maximum} characters`);
  }
  return trimmed;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TetoOutputError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}
