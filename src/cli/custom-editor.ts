import {
  Editor,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AppKeybinding } from "./keybindings.js";
import type { KeybindingsManager } from "@earendil-works/pi-tui";

/**
 * Pi's application editor boundary.
 *
 * The base editor owns text editing and autocomplete. Application actions are
 * layered here so replacing a selector never changes the editor lifecycle or
 * focus target.
 */
export class CustomEditor extends Editor {
  readonly actionHandlers = new Map<AppKeybinding, () => void>();
  private readonly keybindings: KeybindingsManager;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options?: EditorOptions,
  ) {
    super(tui, theme, options);
    this.keybindings = keybindings;
  }

  onAction(action: AppKeybinding, handler: () => void): void {
    this.actionHandlers.set(action, handler);
  }

  override handleInput(data: string): void {
    if (this.onExtensionShortcut?.(data)) return;

    if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
      this.onPasteImage?.();
      return;
    }

    if (this.keybindings.matches(data, "app.interrupt")) {
      if (!this.isShowingAutocomplete()) {
        const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
        if (handler) {
          handler();
          return;
        }
      }
      super.handleInput(data);
      return;
    }

    if (this.keybindings.matches(data, "app.exit")) {
      if (this.getText().length === 0) {
        const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
        handler?.();
        return;
      }
    }

    // Pi gives explicit history bindings precedence over application actions
    // such as model cycling when the editor owns the input.
    if (
      this.keybindings.matches(data, "tui.editor.historyPrevious")
      || this.keybindings.matches(data, "tui.editor.historyNext")
    ) {
      super.handleInput(data);
      return;
    }

    for (const [action, handler] of this.actionHandlers) {
      if (action === "app.interrupt" || action === "app.exit") continue;
      if (this.keybindings.matches(data, action)) {
        handler();
        return;
      }
    }

    super.handleInput(data);
  }
}
