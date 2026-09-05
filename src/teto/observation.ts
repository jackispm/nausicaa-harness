import type {
  AdviceDisposition,
  Goal,
  NavigationDelta,
  ObservationFrame,
} from "../domain/index.js";

export interface ObservationFrameInput {
  goal: Goal;
  mainDelta: NavigationDelta;
  previousAdviceOutcome?: {
    adviceId: string;
    disposition: AdviceDisposition;
    reason?: string;
  };
  budget: {
    maxOutputTokens: number;
    deadline: string;
  };
}

export interface ObservationFrameBuilderOptions {
  maxDynamicTokens?: number;
  maxAdviceOutputTokens?: number;
  maxOpenQuestions?: number;
  maxUncertainties?: number;
}

const defaults = {
  maxDynamicTokens: 600,
  maxAdviceOutputTokens: 200,
  maxOpenQuestions: 5,
  maxUncertainties: 5,
} as const;

export class ObservationFrameBuilder {
  readonly options: Required<ObservationFrameBuilderOptions>;

  constructor(options: ObservationFrameBuilderOptions = {}) {
    this.options = { ...defaults, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  build(input: ObservationFrameInput): ObservationFrame {
    let truncated = false;
    const uncertainties = input.mainDelta.uncertainties.slice(
      0,
      this.options.maxUncertainties,
    );
    const openQuestions = input.mainDelta.openQuestions.slice(
      0,
      this.options.maxOpenQuestions,
    );
    truncated ||= uncertainties.length !== input.mainDelta.uncertainties.length;
    truncated ||= openQuestions.length !== input.mainDelta.openQuestions.length;

    const requestedOutputTokens = positiveInteger(
      input.budget.maxOutputTokens,
      "maxOutputTokens",
    );
    const maxOutputTokens = Math.min(
      requestedOutputTokens,
      this.options.maxAdviceOutputTokens,
    );
    truncated ||= maxOutputTokens !== requestedOutputTokens;

    const frame: ObservationFrame = {
      mission: {
        goalVersion: input.goal.version,
        goal: input.goal.statement,
        successCriteria: [...input.goal.successCriteria],
        hardConstraints: [...input.goal.hardConstraints],
      },
      mainDelta: {
        boundaryId: input.mainDelta.boundaryId,
        triggerKind: input.mainDelta.triggerKind,
        activeObjective: input.mainDelta.activeObjective,
        actionOrDecision: input.mainDelta.actionOrDecision,
        expectedOutcome: input.mainDelta.expectedOutcome,
        outcome: input.mainDelta.outcome,
        status: input.mainDelta.status,
        uncertainties,
        openQuestions,
      },
      ...(input.previousAdviceOutcome === undefined
        ? {}
        : {
            previousAdviceOutcome: {
              adviceId: input.previousAdviceOutcome.adviceId,
              disposition: input.previousAdviceOutcome.disposition,
              ...(input.previousAdviceOutcome.reason === undefined
                ? {}
                : { reason: input.previousAdviceOutcome.reason }),
            },
          }),
      budget: {
        maxOutputTokens,
        deadline: input.budget.deadline,
      },
      truncated,
    };

    validateDate(frame.budget.deadline, "deadline");
    truncateDynamicFrame(frame, this.options.maxDynamicTokens);
    return frame;
  }
}

export function estimateObservationDynamicTokens(frame: ObservationFrame): number {
  const dynamic = {
    mainDelta: frame.mainDelta,
    ...(frame.previousAdviceOutcome === undefined
      ? {}
      : { previousAdviceOutcome: frame.previousAdviceOutcome }),
    budget: frame.budget,
    truncated: frame.truncated,
  };
  // UTF-8 bytes are a conservative upper bound for byte-fallback tokenizers.
  return Buffer.byteLength(JSON.stringify(dynamic), "utf8");
}

function truncateDynamicFrame(frame: ObservationFrame, limit: number): void {
  if (estimateObservationDynamicTokens(frame) <= limit) {
    return;
  }
  frame.truncated = true;

  const optionalArrays = [
    frame.mainDelta.openQuestions,
    frame.mainDelta.uncertainties,
  ];
  while (
    estimateObservationDynamicTokens(frame) > limit
    && optionalArrays.some((items) => items.length > 1)
  ) {
    const longest = optionalArrays.reduce((left, right) =>
      serializedLength(right) > serializedLength(left) ? right : left,
    );
    longest.pop();
  }

  const accessors: Array<{
    get: () => string;
    set: (value: string) => void;
  }> = [
    {
      get: () => frame.mainDelta.activeObjective,
      set: (value) => { frame.mainDelta.activeObjective = value; },
    },
    {
      get: () => frame.mainDelta.actionOrDecision,
      set: (value) => { frame.mainDelta.actionOrDecision = value; },
    },
    {
      get: () => frame.mainDelta.expectedOutcome,
      set: (value) => { frame.mainDelta.expectedOutcome = value; },
    },
    {
      get: () => frame.mainDelta.outcome,
      set: (value) => { frame.mainDelta.outcome = value; },
    },
    ...frame.mainDelta.uncertainties.map((_, index) => ({
      get: () => frame.mainDelta.uncertainties[index] ?? "",
      set: (value: string) => { frame.mainDelta.uncertainties[index] = value; },
    })),
    ...frame.mainDelta.openQuestions.map((_, index) => ({
      get: () => frame.mainDelta.openQuestions[index] ?? "",
      set: (value: string) => { frame.mainDelta.openQuestions[index] = value; },
    })),
  ];
  if (frame.previousAdviceOutcome?.reason !== undefined) {
    accessors.push({
      get: () => frame.previousAdviceOutcome?.reason ?? "",
      set: (value) => {
        if (frame.previousAdviceOutcome !== undefined) {
          frame.previousAdviceOutcome.reason = value;
        }
      },
    });
  }

  while (estimateObservationDynamicTokens(frame) > limit) {
    const candidate = accessors.reduce((longest, current) =>
      current.get().length > longest.get().length ? current : longest,
    );
    const value = candidate.get();
    if (value.length === 0) {
      throw new RangeError(
        `ObservationFrame structural data exceeds the ${limit}-token dynamic budget`,
      );
    }
    const excess = estimateObservationDynamicTokens(frame) - limit;
    const removeCount = Math.max(1, Math.min(value.length, excess));
    candidate.set(shorten(value, value.length - removeCount));
  }
}

function shorten(value: string, length: number): string {
  if (length <= 3) {
    return "";
  }
  return `${value.slice(0, length - 3)}...`;
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function validateDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date string`);
  }
}
