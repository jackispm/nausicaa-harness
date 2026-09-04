/**
 * The interactive command contract shared by help, completion, and dispatch.
 *
 * `visibility` keeps compatibility entries explicit while allowing the
 * existing command surface to remain usable during the migration.
 */

export type CommandReference = "prime" | "codex" | "pi";
export type CommandAlignment = "shared" | "semantic-review" | "pending-approval";
export type CommandVisibility = "public" | "compatibility";

export interface InteractiveCommandSpec {
  /** Name without the leading slash. */
  name: string;
  description: string;
  argumentHint?: string;
  references: readonly CommandReference[];
  alignment: CommandAlignment;
  visibility: CommandVisibility;
  /** Hidden names accepted during the command-surface migration. */
  aliases?: readonly string[];
}

const command = (
  spec: Omit<InteractiveCommandSpec, "aliases"> & { aliases?: readonly string[] },
): InteractiveCommandSpec => Object.freeze({
  ...spec,
  ...(spec.argumentHint === undefined ? {} : { argumentHint: spec.argumentHint }),
  ...(spec.aliases === undefined ? {} : { aliases: Object.freeze([...spec.aliases]) }),
  references: Object.freeze([...spec.references]),
});

/**
 * Commands are ordered as they should appear in `/help` and autocomplete.
 * Compatibility commands remain executable because removing an established
 * command is a breaking change, even when its preferred spelling has changed.
 */
export const PUBLIC_INTERACTIVE_COMMANDS: readonly InteractiveCommandSpec[] = Object.freeze([
  command({
    name: "help",
    description: "Show interactive commands",
    references: ["prime", "codex", "pi"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "setup",
    description: "Show local model and credential setup status",
    references: ["prime", "pi"],
    alignment: "semantic-review",
    visibility: "compatibility",
  }),
  command({
    name: "status",
    description: "Show current session configuration and usage",
    references: ["codex"],
    alignment: "semantic-review",
    visibility: "public",
  }),
  command({
    name: "login",
    description: "Sign in to the current model provider",
    argumentHint: "[provider]",
    references: ["prime", "pi", "codex"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "logout",
    description: "Remove the saved model-provider credential",
    argumentHint: "[provider]",
    references: ["prime", "pi", "codex"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "agents",
    description: "View active agent sessions or the local topology",
    references: ["prime", "codex"],
    alignment: "semantic-review",
    visibility: "public",
    aliases: ["topology"],
  }),
  command({
    name: "edges",
    description: "Show configured edge sources and refresh",
    argumentHint: "[refresh]",
    references: ["pi"],
    alignment: "semantic-review",
    visibility: "compatibility",
  }),
  command({
    name: "skills",
    description: "Inspect and select Skills for the next Turn",
    argumentHint: "[refresh|select|deselect]",
    references: ["codex", "prime", "pi"],
    alignment: "semantic-review",
    visibility: "public",
  }),
  command({
    name: "context",
    description: "Show context and token usage",
    references: ["prime", "pi"],
    alignment: "shared",
    visibility: "public",
    aliases: ["usage"],
  }),
  command({
    name: "compact",
    description: "Compact committed conversation context",
    references: ["pi", "codex"],
    alignment: "semantic-review",
    visibility: "public",
  }),
  command({
    name: "model",
    description: "Choose the model",
    argumentHint: "[model]",
    references: ["prime", "codex", "pi"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "permissions",
    description: "Choose what tools are allowed to do",
    argumentHint: "[read-only|workspace|full-access]",
    references: ["codex"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "mode",
    description: "Switch between Default and Plan",
    argumentHint: "[default|plan]",
    references: ["codex"],
    alignment: "shared",
    visibility: "compatibility",
  }),
  command({
    name: "plan",
    description: "Switch to Plan mode",
    argumentHint: "[prompt]",
    references: ["codex"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "theme",
    description: "Choose the TUI color scheme",
    argumentHint: "[auto|light|dark]",
    references: ["codex", "prime", "pi"],
    alignment: "semantic-review",
    visibility: "public",
  }),
  command({
    name: "goal",
    description: "View or manage the optional long-running thread goal",
    argumentHint: "[status|<objective>|--budget <tokens> <objective>|edit <objective>|pause|resume|clear]",
    references: ["prime", "codex"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "session",
    description: "Switch between workspace Runs",
    argumentHint: "[run-id]",
    references: ["prime", "pi"],
    alignment: "semantic-review",
    visibility: "public",
  }),
  command({
    name: "tree",
    description: "Navigate the workspace Run tree and historical checkpoints",
    references: ["pi"],
    alignment: "semantic-review",
    visibility: "public",
  }),
  command({
    name: "fork",
    description: "Fork the current Run from its latest committed checkpoint",
    argumentHint: "[run-id]",
    references: ["pi", "codex"],
    alignment: "semantic-review",
    visibility: "public",
    aliases: ["branch"],
  }),
  command({
    name: "new",
    description: "Start a new session",
    references: ["prime", "codex", "pi"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "resume",
    description: "Resume a saved session",
    argumentHint: "[run-id]",
    references: ["codex", "pi"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "resolve",
    description: "Resolve an unknown tool operation",
    argumentHint: "<operation-id>",
    references: ["pi"],
    alignment: "semantic-review",
    visibility: "compatibility",
  }),
  command({
    name: "copy",
    description: "Copy the last assistant response",
    references: ["prime", "codex", "pi"],
    alignment: "shared",
    visibility: "public",
  }),
  command({
    name: "stop",
    description: "Stop the active Turn",
    references: ["codex"],
    alignment: "shared",
    visibility: "public",
    aliases: ["cancel"],
  }),
  command({
    name: "quit",
    description: "Exit Nausicaa",
    references: ["prime", "codex", "pi"],
    alignment: "shared",
    visibility: "public",
    aliases: ["exit"],
  }),
]);

/**
 * Kept as an extension point for future commands that are intentionally not
 * executable yet. Existing compatibility commands must not be placed here.
 */
export const PENDING_APPROVAL_COMMANDS = Object.freeze([] as const);

const COMMAND_BY_NAME = new Map<string, InteractiveCommandSpec>();
for (const spec of PUBLIC_INTERACTIVE_COMMANDS) {
  if (COMMAND_BY_NAME.has(spec.name)) {
    throw new Error(`Duplicate interactive command: /${spec.name}`);
  }
  COMMAND_BY_NAME.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) {
    if (COMMAND_BY_NAME.has(alias)) {
      throw new Error(`Duplicate interactive command alias: /${alias}`);
    }
    COMMAND_BY_NAME.set(alias, spec);
  }
}

export function findInteractiveCommand(name: string): InteractiveCommandSpec | undefined {
  const normalized = name.startsWith("/") ? name.slice(1) : name;
  return COMMAND_BY_NAME.get(normalized);
}

export function canonicalInteractiveCommandName(name: string): string {
  return findInteractiveCommand(name)?.name ?? (name.startsWith("/") ? name.slice(1) : name);
}

export function publicInteractiveCommandSpecs(): readonly InteractiveCommandSpec[] {
  return PUBLIC_INTERACTIVE_COMMANDS;
}

export function formatInteractiveCommandHelp(): string {
  return PUBLIC_INTERACTIVE_COMMANDS
    .map((spec) => {
      const aliasText = spec.aliases === undefined || spec.aliases.length === 0
        ? ""
        : ` (alias: ${spec.aliases.map((alias) => `/${alias}`).join(", ")})`;
      return `\`/${spec.name}${spec.argumentHint === undefined ? "" : ` ${spec.argumentHint}`}\` ${spec.description}${aliasText}`;
    })
    .join("\n\n");
}
