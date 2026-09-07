import { fuzzyFilter, stripTerminalSequences } from "@earendil-works/pi-tui";

import { normalizeModelSelector as normalizeRuntimeModelSelector } from "../model/index.js";
import type {
  SelectableSessionPermissionProfile,
  SessionCollaborationMode,
  SessionPermissionProfile,
} from "../runtime/index.js";
import type { WorkspaceSandboxAvailability } from "../tools/index.js";

/** Small helpers for Prime-style command selectors. */

export interface SelectorOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ModelSelectorCandidate extends SelectorOption {
  /** Provider-owned local metadata, when available. */
  contextWindowTokens?: number;
  imageInput?: boolean;
  toolUse?: boolean | "unknown";
  authStatus?: "unverified";
}

export type ThemeChoice = "auto" | "light" | "dark";

export function permissionProfileOptions(
  current: SessionPermissionProfile,
  workspaceBashAvailability?: WorkspaceSandboxAvailability,
): SelectorOption[] {
  return [
    {
      value: "read-only",
      label: "Read Only",
      description: "Inspect workspace files; no writes, shell, or network",
    },
    {
      value: "workspace",
      label: "Workspace",
      description: workspacePermissionDescription(workspaceBashAvailability),
    },
    {
      value: "full-access",
      label: "Full Access",
      description: "Workspace writes, host-level shell, network, and background jobs",
    },
  ].map((option) => ({
    ...option,
    ...(option.value === current ? { description: `${option.description} (current)` } : {}),
  }));
}

function workspacePermissionDescription(
  availability: WorkspaceSandboxAvailability | undefined,
): string {
  if (availability === undefined) {
    return "Read and edit inside the workspace; Git metadata is read-only; sandboxed Bash is capability-dependent; no network";
  }
  if (availability.available) {
    return `Read, edit, and run sandboxed Bash inside the workspace (${availability.backend}); Git metadata is read-only; use full-access for repository writes; no network`;
  }
  return `Read and edit inside the workspace; Git metadata is read-only; sandboxed Bash unavailable: ${availability.reason}; no network`;
}

export function parsePermissionProfile(
  value: string,
): SelectableSessionPermissionProfile {
  const profile = value.trim().toLocaleLowerCase();
  if (profile !== "read-only" && profile !== "workspace" && profile !== "full-access") {
    throw new Error("/permissions expects read-only, workspace, or full-access");
  }
  return profile;
}

export function collaborationModeOptions(
  current: SessionCollaborationMode,
): SelectorOption[] {
  return [
    {
      value: "default",
      label: "Default",
      description: "Investigate, edit, and verify within the selected permissions",
    },
    {
      value: "plan",
      label: "Plan",
      description: "Read-only investigation followed by an implementation-ready plan",
    },
  ].map((option) => ({
    ...option,
    ...(option.value === current ? { description: `${option.description} (current)` } : {}),
  }));
}

export function parseCollaborationMode(value: string): SessionCollaborationMode {
  const mode = value.trim().toLocaleLowerCase();
  if (mode !== "default" && mode !== "plan") {
    throw new Error("/mode expects default or plan");
  }
  return mode;
}

/**
 * Reuse pi-tui's token-aware fuzzy matcher so model search behaves like the
 * upstream selector without importing Prime's model registry or auth layer.
 */
export function filterSelectorOptions(
  options: readonly SelectorOption[],
  query = "",
): SelectorOption[] {
  return fuzzyFilter(
    [...options],
    query,
    (option) => `${option.label} ${option.value} ${option.description ?? ""}`,
  );
}

export function modelSelectorOptions(
  current: string,
  tetoModel: string,
  additional: readonly (string | ModelSelectorCandidate)[] = [],
): SelectorOption[] {
  const candidates = new Map<string, ModelSelectorCandidate>();
  const add = (candidate: string | ModelSelectorCandidate, fallbackDescription: string): void => {
    const option = typeof candidate === "string"
      ? { value: candidate.trim(), label: candidate.trim(), description: fallbackDescription }
      : {
          ...candidate,
          value: candidate.value.trim(),
          label: candidate.label.trim() || candidate.value.trim(),
        };
    if (option.value.length === 0) return;
    if (candidates.has(option.value) && typeof candidate === "string") return;
    candidates.set(option.value, option);
  };
  add(current, "Main lane");
  add(tetoModel, "Teto lane");
  for (const candidate of additional) add(candidate, "Configured candidate");
  return [...candidates.values()].map((option) => {
    const lane = option.value === current
      ? "Main lane"
      : option.value === tetoModel
        ? "Teto lane"
        : undefined;
    const description = [lane, option.description === lane ? undefined : option.description]
      .filter(Boolean).join(" · ") || "Configured candidate";
    return { ...option, description };
  });
}

export function themeSelectorOptions(current: ThemeChoice): SelectorOption[] {
  return [
    { value: "auto", label: "auto", description: "Follow the terminal color scheme" },
    { value: "light", label: "light", description: "Use the light Nausicaa palette" },
    { value: "dark", label: "dark", description: "Use the dark Nausicaa palette" },
  ].map((option) => ({
    ...option,
    ...(option.value === current ? { description: `${option.description} (current)` } : {}),
  }));
}

export function parseThemeChoice(value: string): ThemeChoice {
  const choice = value.trim().toLocaleLowerCase();
  if (choice !== "auto" && choice !== "light" && choice !== "dark") {
    throw new Error("/theme expects auto, light, or dark");
  }
  return choice;
}

/** Validate a model selector before applying it to the Session. */
export function normalizeModelSelector(value: string): string {
  try {
    return normalizeRuntimeModelSelector(value);
  } catch {
    throw new Error("/model expects a non-empty model selector without spaces");
  }
}

export interface SkillSelectorInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly sourceId?: string;
  readonly selected: boolean;
  readonly disabled: boolean;
}

/** Add compact selection/disabled state without exposing Skill bodies. */
export function skillSelectorOptions(
  skills: readonly SkillSelectorInput[],
): SelectorOption[] {
  return skills.map((skill) => ({
    value: skill.id,
    label: `${skill.selected ? "[x]" : "[ ]"} ${terminalSafeSelectorText(skill.name)}`,
    description: [
      skill.disabled ? "disabled" : skill.selected ? "selected for next Turn" : "available",
      skill.sourceId,
      skill.description === undefined ? undefined : terminalSafeSelectorText(skill.description),
    ].filter((value): value is string => value !== undefined && value.length > 0).join(" · "),
    disabled: skill.disabled,
  }));
}

function terminalSafeSelectorText(value: string): string {
  return stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f]/g, "");
}
