/**
 * Qualitative descriptions adapted from Pi coding-agent 0.85.0's
 * thinking-selector.ts, upstream 9767ba275f3e9a5ee0f5c5342249b629ab1b2282.
 * MIT; Copyright (c) 2025 Mario Zechner. See docs/thinking-levels.md.
 */
import type { ThinkingLevel } from "../domain/ports.js";
import type { AuthMenuChoice } from "./auth-menu.js";

const LEVEL_DESCRIPTIONS: Readonly<Record<ThinkingLevel, string>> = {
  off: "No reasoning",
  minimal: "Very brief reasoning",
  low: "Light reasoning",
  medium: "Moderate reasoning",
  high: "Deep reasoning",
  xhigh: "Extra-high reasoning",
  max: "Maximum reasoning",
};

export interface ThinkingLevelChoiceOptions {
  readonly levels: readonly ThinkingLevel[];
  readonly current?: ThinkingLevel | undefined;
  /** Only a known explicit harness default may label a concrete level. */
  readonly defaultLevel?: ThinkingLevel | undefined;
}

export function thinkingLevelChoices(options: ThinkingLevelChoiceOptions): AuthMenuChoice[] {
  const levels = [...new Set(options.levels)];
  return [
    {
      value: "default",
      label: "Provider default",
      detail: levels.length === 0 ? "No adjustable reasoning levels" : "Use the provider's default reasoning",
      ...(options.current === undefined ? { status: "current" } : {}),
    },
    ...levels.map((level) => ({
      value: level,
      label: level,
      detail: `${LEVEL_DESCRIPTIONS[level]}${level === options.defaultLevel ? " (default)" : ""}`,
      ...(level === options.current ? { status: "current" } : {}),
    })),
  ];
}

/** Format a display label without changing the underlying model selector. */
export function formatModelThinkingLabel(model: string, level?: ThinkingLevel): string {
  return level === undefined ? model : `${model} \u2022 ${level}`;
}
