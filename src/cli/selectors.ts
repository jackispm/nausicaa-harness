import { fuzzyFilter } from "@earendil-works/pi-tui";

/** Small helpers for Prime-style command selectors. */

export interface SelectorOption {
  value: string;
  label: string;
  description?: string;
}

export type ThemeChoice = "auto" | "light" | "dark";

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
  additional: readonly string[] = [],
): SelectorOption[] {
  const values = [...new Set([current, tetoModel, ...additional].map((value) => value.trim()))]
    .filter((value) => value.length > 0);
  return values.map((value) => ({
    value,
    label: value,
    ...(value === current
      ? { description: "Main lane" }
      : value === tetoModel
        ? { description: "Teto lane" }
        : { description: "Configured candidate" }),
  }));
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

/** Validate a model selector before displaying a restart command. */
export function normalizeModelSelector(value: string): string {
  const selector = value.trim();
  if (selector.length === 0 || selector.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(selector)) {
    throw new Error("/model expects a non-empty model selector without spaces");
  }
  return selector;
}
