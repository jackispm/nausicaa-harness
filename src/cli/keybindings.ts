import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type Keybinding,
  type KeybindingsConfig,
  type KeybindingDefinitions,
} from "@earendil-works/pi-tui";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Application bindings shared by the editor and every selector component. */
const APP_KEYBINDINGS = {
  "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
  "app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
  "app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking" },
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.agentMessages.toggle": { defaultKeys: "ctrl+p", description: "Expand or collapse agent messages" },
  "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up" },
  "app.message.dequeue": { defaultKeys: "alt+up", description: "Edit queued input" },
  "app.message.queueNext": { defaultKeys: "alt+down", description: "Next queued input" },
  "app.prompt.stash": { defaultKeys: "ctrl+s", description: "Stash or restore prompt" },
  // Ctrl+V is the portable terminal binding. Windows terminals commonly
  // reserve it for text paste, so keep Alt+V there while retaining Ctrl+V on
  // macOS and Linux (and in the test/embedding terminal contract).
  "app.clipboard.pasteImage": { defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v", description: "Paste image" },
} as const satisfies KeybindingDefinitions;

export const NAUSICAA_KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  ...APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

export type AppKeybinding = keyof typeof APP_KEYBINDINGS;

declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    "app.interrupt": true;
    "app.clear": true;
    "app.exit": true;
    "app.thinking.toggle": true;
    "app.tools.expand": true;
    "app.agentMessages.toggle": true;
    "app.message.followUp": true;
    "app.message.dequeue": true;
    "app.message.queueNext": true;
    "app.prompt.stash": true;
    "app.clipboard.pasteImage": true;
  }
}

export function createKeybindings(): KeybindingsManager {
  const manager = new KeybindingsManager(NAUSICAA_KEYBINDINGS);
  setKeybindings(manager);
  return manager;
}

export function userKeybindingsPath(): string {
  return join(homedir(), ".nausicaa", "keybindings.json");
}

/** Validate completely before replacing the live bindings; failed reloads keep the old map. */
export async function reloadKeybindings(
  manager: KeybindingsManager,
  path = userKeybindingsPath(),
): Promise<void> {
  let source: string;
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024) {
        throw new Error("Keyboard shortcuts must be a JSON file of at most 64 KiB");
      }
      const bytes = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 64 * 1024) throw new Error("Keyboard shortcut file is too large");
      source = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manager.setUserBindings({});
    return;
  }
  const parsed: unknown = JSON.parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Keyboard shortcuts must be a JSON object");
  }
  const bindings: KeybindingsConfig = {};
  for (const [action, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(NAUSICAA_KEYBINDINGS, action)) throw new Error(`Unknown keyboard action: ${action}`);
    const keys = typeof value === "string" ? [value] : value;
    if (!Array.isArray(keys) || keys.length > 8 || !keys.every((key) => (
      typeof key === "string" && key.length > 0 && key.length <= 64
      && /^(?:(?:ctrl|alt|shift)\+)*(?:[a-z0-9]|enter|escape|tab|space|backspace|delete|insert|home|end|up|down|left|right|pageUp|pageDown|f[1-9][0-2]?|[\[\]\\/.,;`'=?-])$/u.test(key)
    ))) throw new Error(`Invalid keyboard shortcuts for ${action}`);
    bindings[action] = keys as KeybindingsConfig[string];
  }
  manager.setUserBindings(bindings);
}

export function formatHotkeys(manager: KeybindingsManager, fullscreen = false): string {
  const rows = Object.entries(NAUSICAA_KEYBINDINGS).flatMap(([action, definition]) => {
    if (!fullscreen && action.startsWith("tui.altScreen.")) return [];
    // Ctrl+C is intercepted by the application, not the base input selection handler.
    if (action === "tui.input.copy") return [];
    const keys = manager.getKeys(action as Keybinding);
    return keys.length === 0 ? [] : [`- ${keys.map((key) => `\`${key}\``).join(", ")}: ${definition.description}`];
  });
  return ["### Keyboard shortcuts", ...rows, "- `?`: show shortcut guide when the prompt is empty", "- `!` / `!!`: run shell command with / without adding its output to context", "- Press the clear/cancel binding twice while idle to exit"].join("\n");
}
