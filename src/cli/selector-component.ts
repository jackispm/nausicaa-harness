import {
  Container,
  Input,
  type Focusable,
  getKeybindings,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import {
  nausicaaEditorTheme,
  nausicaaMarkdownTheme,
} from "./tui-components.js";
import {
  filterSelectorOptions,
  type SelectorOption,
} from "./selectors.js";

export interface SelectorOverlayOptions {
  title: string;
  subtitle?: string;
  options: readonly SelectorOption[];
  current?: string;
  initialQuery?: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
  onPreview?: (value: string) => void;
}

const SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 40,
};
const PAGE_SIZE = 8;

const SELECT_LIST_THEME: SelectListTheme = nausicaaEditorTheme.selectList;

/**
 * Small Prime-style selector mounted in the prompt slot.
 *
 * Input and SelectList are kept as separate pi-tui components so IME cursor
 * positioning remains correct while the list owns navigation and selection.
 */
export class SelectorOverlay extends Container implements Focusable {
  private readonly search = new Input();
  private list: SelectList;
  private readonly allOptions: readonly SelectorOption[];
  private filteredOptions: readonly SelectorOption[];
  private readonly title: string;
  private readonly subtitle: string | undefined;
  private readonly onSelect: (value: string) => void;
  private readonly onCancel: () => void;
  private readonly onPreview: ((value: string) => void) | undefined;
  private _focused = false;

  constructor(options: SelectorOverlayOptions) {
    super();
    this.title = options.title;
    this.subtitle = options.subtitle;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.onPreview = options.onPreview;
    this.allOptions = [...options.options];
    this.filteredOptions = this.allOptions;

    this.list = this.createList(this.filteredOptions);

    const currentIndex = options.current === undefined
      ? -1
      : this.allOptions.findIndex((item) => item.value === options.current);
    if (options.initialQuery !== undefined && options.initialQuery.length > 0) {
      this.search.setValue(options.initialQuery);
      this.replaceList(options.initialQuery);
      if (options.current !== undefined) {
        const filteredIndex = filterSelectorOptions(this.allOptions, options.initialQuery)
          .findIndex((option) => option.value === options.current);
        if (filteredIndex >= 0) this.list.setSelectedIndex(filteredIndex);
      }
    } else if (currentIndex >= 0) {
      this.list.setSelectedIndex(currentIndex);
    }
    this.search.onEscape = () => this.onCancel();
  }

  private createList(options: readonly SelectorOption[]): SelectList {
    const items: SelectItem[] = options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
    const list = new SelectList(
      items,
      Math.max(3, Math.min(8, items.length || 3)),
      SELECT_LIST_THEME,
      SELECT_LIST_LAYOUT,
    );
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = () => this.onCancel();
    list.onSelectionChange = (item) => this.onPreview?.(item.value);
    return list;
  }

  private replaceList(query: string): void {
    const previousValue = this.getSelectedValue();
    const filtered = filterSelectorOptions(this.allOptions, query);
    this.filteredOptions = filtered;
    this.list = this.createList(filtered);
    const selectedIndex = previousValue === undefined
      ? -1
      : filtered.findIndex((option) => option.value === previousValue);
    if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
  }

  private movePage(direction: -1 | 1): void {
    if (this.filteredOptions.length === 0) return;
    const selected = this.getSelectedValue();
    const currentIndex = selected === undefined
      ? 0
      : Math.max(0, this.filteredOptions.findIndex((option) => option.value === selected));
    const nextIndex = Math.max(
      0,
      Math.min(this.filteredOptions.length - 1, currentIndex + direction * PAGE_SIZE),
    );
    this.list.setSelectedIndex(nextIndex);
    this.onPreview?.(this.getSelectedValue() ?? "");
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  getSearchInput(): Input {
    return this.search;
  }

  getSelectedValue(): string | undefined {
    return this.list.getSelectedItem()?.value;
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.pageUp")) {
      this.movePage(-1);
      return;
    }
    if (keybindings.matches(data, "tui.select.pageDown")) {
      this.movePage(1);
      return;
    }
    if (
      keybindings.matches(data, "tui.select.up")
      || keybindings.matches(data, "tui.select.down")
      || keybindings.matches(data, "tui.select.confirm")
      || keybindings.matches(data, "tui.select.cancel")
    ) {
      if (
        (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down"))
        && this.list.getSelectedItem() === null
      ) return;
      this.list.handleInput(data);
      return;
    }

    this.search.handleInput(data);
    this.replaceList(this.search.getValue());
    this.onPreview?.(this.getSelectedValue() ?? "");
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [
      truncateToWidth(nausicaaMarkdownTheme.heading(this.title), safeWidth, ""),
    ];
    if (this.subtitle !== undefined && this.subtitle.trim().length > 0) {
      lines.push(truncateToWidth(nausicaaMarkdownTheme.linkUrl(this.subtitle), safeWidth, ""));
    }
    lines.push(
      truncateToWidth("Search", safeWidth, ""),
      ...this.search.render(safeWidth),
      ...this.list.render(safeWidth),
      truncateToWidth("  Up/Down navigate | Enter select | Esc cancel", safeWidth, ""),
    );
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  override invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }
}
