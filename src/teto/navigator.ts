import { randomUUID } from "node:crypto";
import type {
  Advice,
  AdviceKind,
  Clock,
  LaneId,
  ModelPort,
  ObservationFrame,
  RunId,
} from "../domain/index.js";
import { systemClock } from "../domain/index.js";

export const TETO_SYSTEM_PROMPT = `You are Teto, a sparse intent navigator beside a primary agent.
Check only whether the current action serves the mission, whether user intent is missing, or whether a materially simpler method exists. Do not inspect bugs or invent unavailable evidence.
Usually stay silent. Only propose when there is a real course error, intent gap, or clearly better method. For silence return exactly {"action":"silent"}.
Otherwise return one JSON object and no markdown with exactly these keys: kind, claim, evidenceRefs, confidence, risk, suggestedAction, urgency, expiresAt, dedupeKey.
kind is orientation, intent-gap, or method-alternative. confidence is 0..1. risk is low, medium, or high. urgency is next-step, next-turn, or deferred. Keep the result concise.`;

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
    this.modelPort = options.modelPort;
    this.model = options.model;
    this.laneId = options.laneId ?? "teto";
    this.clock = options.clock ?? systemClock;
    this.createAdviceId = options.createAdviceId ?? randomUUID;
    this.maxAdviceOutputTokens = options.maxAdviceOutputTokens ?? 200;
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

    if (response.toolCalls.length !== 0) {
      throw new TetoOutputError("Teto must not request tools");
    }
    if (response.usage.output > maxOutputTokens) {
      throw new TetoOutputError(
        `Teto output used ${response.usage.output} tokens; limit is ${maxOutputTokens}`,
      );
    }

    const advice = parseAdviceJson(response.content, {
      adviceId: this.createAdviceId(),
      sourceLane: this.laneId,
      now,
    });
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
}

const adviceKeys = [
  "claim",
  "confidence",
  "dedupeKey",
  "evidenceRefs",
  "expiresAt",
  "kind",
  "risk",
  "suggestedAction",
  "urgency",
] as const;

export class TetoOutputError extends Error {
  override readonly name = "TetoOutputError";
}

export function parseAdviceJson(
  text: string,
  options: ParseAdviceOptions,
): Advice | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TetoOutputError("Teto output must be a single JSON object");
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

  const kind = enumValue(value.kind, [
    "orientation",
    "intent-gap",
    "method-alternative",
  ] as const, "kind");
  const claim = nonEmptyString(value.claim, "claim");
  const evidenceRefs = stringArray(value.evidenceRefs, "evidenceRefs", 8);
  const confidence = finiteNumber(value.confidence, "confidence");
  if (confidence < 0 || confidence > 1) {
    throw new TetoOutputError("confidence must be between 0 and 1");
  }
  const risk = enumValue(value.risk, ["low", "medium", "high"] as const, "risk");
  const suggestedAction = nonEmptyString(value.suggestedAction, "suggestedAction");
  const urgency = enumValue(
    value.urgency,
    ["next-step", "next-turn", "deferred"] as const,
    "urgency",
  );
  const expiresAt = nonEmptyString(value.expiresAt, "expiresAt");
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= options.now.getTime()) {
    throw new TetoOutputError("expiresAt must be a future ISO date");
  }
  const dedupeKey = nonEmptyString(value.dedupeKey, "dedupeKey");

  return {
    adviceId: options.adviceId,
    kind: kind as AdviceKind,
    claim,
    evidenceRefs,
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

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TetoOutputError(`${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string, maximum: number): string[] {
  if (
    !Array.isArray(value)
    || value.length > maximum
    || value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new TetoOutputError(`${field} must contain at most ${maximum} strings`);
  }
  return [...new Set(value)];
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TetoOutputError(`${field} must be a finite number`);
  }
  return value;
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
