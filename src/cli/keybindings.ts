import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type KeybindingDefinitions,
} from "@earendil-works/pi-tui";

/** Application bindings shared by the editor and every selector component. */
const APP_KEYBINDINGS = {
  "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
  "app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
  "app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking" },
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle model" },
  "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up" },
  "app.message.dequeue": { defaultKeys: "alt+up", description: "Edit queued input" },
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste image" },
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
    "app.model.cycleForward": true;
    "app.message.followUp": true;
    "app.message.dequeue": true;
    "app.clipboard.pasteImage": true;
  }
}

export function createKeybindings(): KeybindingsManager {
  const manager = new KeybindingsManager(NAUSICAA_KEYBINDINGS);
  setKeybindings(manager);
  return manager;
}
