import {
  Container,
  type Component,
  Input,
  type Focusable,
  getKeybindings,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
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
  subtitle?: string | ((visibleOptions: readonly SelectorOption[]) => string);
  /** Search caption; session history uses Codex-style wording. */
  searchLabel?: string;
  /** Optional Codex-style filter facets rendered beside the search caption. */
  filters?: readonly SelectorFilter[];
  /** Re-project options when a filter facet changes. */
  filterOptions?: (
    options: readonly SelectorOption[],
    values: Readonly<Record<string, string>>,
  ) => readonly SelectorOption[];
  options: readonly SelectorOption[];
  current?: string;
  initialQuery?: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
  onPreview?: (value: string) => void;
  /** Optional multi-select mode used by the Skills picker. */
  multiSelect?: boolean;
  selectedValues?: readonly string[];
  onConfirm?: (values: readonly string[]) => void;
}

export interface SelectorFilterOption {
  value: string;
  label: string;
}

export interface SelectorFilter {
  key: string;
  label: string;
  options: readonly SelectorFilterOption[];
  current?: string;
}

/**
 * Pi's model selector boundary, adapted to Nausicaa's provider-neutral model
 * candidates. The selector owns only its search/list state; the interactive
 * mode owns mounting, focus restoration, and the selection side effect.
 */
export class ModelSelectorComponent extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly allOptions: readonly SelectorOption[];
  private filteredOptions: readonly SelectorOption[];
  private selectedIndex = 0;
  private _focused = false;

  constructor(options: {
    options: readonly SelectorOption[];
    current?: string;
    subtitle?: string;
    initialSearchInput?: string;
    onSelect: (value: string) => void;
    onCancel: () => void;
  }) {
    super();
    this.allOptions = [...options.options];
    this.filteredOptions = this.allOptions;
    if (options.initialSearchInput !== undefined) {
      this.searchInput.setValue(options.initialSearchInput);
    }
    this.searchInput.onEscape = options.onCancel;
    this.searchInput.onSubmit = () => {
      const selected = this.filteredOptions[this.selectedIndex];
      if (selected !== undefined && selected.disabled !== true) options.onSelect(selected.value);
    };

    const currentIndex = options.current === undefined
      ? -1
      : this.allOptions.findIndex((item) => item.value === options.current);
    if (currentIndex >= 0) this.selectedIndex = currentIndex;

    this.addChild(new Text(nausicaaMarkdownTheme.heading("Models"), 0, 0));
    this.addChild(new Spacer(1));
    if (options.subtitle !== undefined && options.subtitle.trim().length > 0) {
      this.addChild(new Text(nausicaaMarkdownTheme.linkUrl(options.subtitle), 0, 0));
      this.addChild(new Spacer(1));
    }
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(new ModelSelectorList(
      () => this.filteredOptions,
      () => this.selectedIndex,
    ));
    this.addChild(new Spacer(1));
    this.addChild(new Text("  Up/Down navigate · Enter select · Esc cancel", 0, 0));
    this.filter(this.searchInput.getValue());
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.searchInput.onEscape?.();
      return;
    }
    if (keybindings.matches(data, "tui.select.up")) {
      if (this.filteredOptions.length > 0) {
        this.selectedIndex = this.selectedIndex === 0
          ? this.filteredOptions.length - 1
          : this.selectedIndex - 1;
      }
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      if (this.filteredOptions.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filteredOptions.length - 1
          ? 0
          : this.selectedIndex + 1;
      }
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      this.searchInput.onSubmit?.(this.searchInput.getValue());
      return;
    }
    this.searchInput.handleInput(data);
    this.filter(this.searchInput.getValue());
  }

  override invalidate(): void {
    this.searchInput.invalidate();
  }

  private filter(query: string): void {
    this.filteredOptions = filterSelectorOptions(this.allOptions, query);
    this.selectedIndex = query.length > 0
      ? 0
      : Math.min(this.selectedIndex, Math.max(0, this.filteredOptions.length - 1));
  }
}

class ModelSelectorList implements Component {
  constructor(
    private readonly readOptions: () => readonly SelectorOption[],
    private readonly readSelectedIndex: () => number,
  ) {}

  render(width: number): string[] {
    const options = this.readOptions();
    const selectedIndex = this.readSelectedIndex();
    if (options.length === 0) return ["  No matching models"];
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxVisible / 2), options.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, options.length);
    const lines = options.slice(startIndex, endIndex).map((option, offset) => {
      const index = startIndex + offset;
      const marker = index === selectedIndex ? "→ " : "  ";
      const line = `${marker}${option.label}${option.description === undefined ? "" : ` [${option.description}]`}`;
      return truncateToWidth(line, Math.max(1, width), "");
    });
    if (startIndex > 0 || endIndex < options.length) {
      lines.push(`  (${selectedIndex + 1}/${options.length})`);
    }
    return lines;
  }

  invalidate(): void {}
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
  private readonly subtitle: SelectorOverlayOptions["subtitle"];
  private readonly searchLabel: string;
  private readonly filters: readonly SelectorFilter[];
  private readonly filterOptions: ((
    options: readonly SelectorOption[],
    values: Readonly<Record<string, string>>,
  ) => readonly SelectorOption[]) | undefined;
  private readonly filterValues: Record<string, string>;
  private filterIndex = 0;
  private readonly onSelect: (value: string) => void;
  private readonly onCancel: () => void;
  private readonly onPreview: ((value: string) => void) | undefined;
  private readonly multiSelect: boolean;
  private readonly onConfirm: ((values: readonly string[]) => void) | undefined;
  private readonly selectedValues = new Set<string>();
  private query = "";
  private _focused = false;

  constructor(options: SelectorOverlayOptions) {
    super();
    this.title = options.title;
    this.subtitle = options.subtitle;
    this.searchLabel = options.searchLabel ?? "Search";
    this.filters = options.filters === undefined ? [] : [...options.filters];
    this.filterOptions = options.filterOptions;
    this.filterValues = {};
    for (const filter of this.filters) {
      const first = filter.options[0]?.value;
      if (first !== undefined) this.filterValues[filter.key] = filter.current ?? first;
    }
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.onPreview = options.onPreview;
    this.multiSelect = options.multiSelect === true;
    this.onConfirm = options.onConfirm;
    for (const value of options.selectedValues ?? []) this.selectedValues.add(value);
    this.allOptions = [...options.options];
    this.filteredOptions = this.projectOptions("");

    this.list = this.createList(this.filteredOptions);

    const currentIndex = options.current === undefined
      ? -1
      : this.filteredOptions.findIndex((item) => item.value === options.current);
    if (options.initialQuery !== undefined && options.initialQuery.length > 0) {
      this.search.setValue(options.initialQuery);
      this.replaceList(options.initialQuery);
    } else if (currentIndex >= 0) {
      this.list.setSelectedIndex(currentIndex);
    }
    this.search.onEscape = () => this.onCancel();
  }

  private projectOptions(query: string): readonly SelectorOption[] {
    const projected = this.filterOptions?.(
      this.allOptions,
      this.filterValues,
    ) ?? this.allOptions;
    return filterSelectorOptions(projected, query);
  }

  private createList(options: readonly SelectorOption[]): SelectList {
    const items: SelectItem[] = options.map((option) => ({
      value: option.value,
      label: this.multiSelect
        ? `[${this.selectedValues.has(option.value) ? "x" : " "}] ${option.label.replace(/^\[[ x]\]\s*/u, "")}`
        : option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
    const list = new SelectList(
      items,
      Math.max(3, Math.min(8, items.length || 3)),
      SELECT_LIST_THEME,
      SELECT_LIST_LAYOUT,
    );
    list.onSelect = (item) => {
      const option = this.allOptions.find((candidate) => candidate.value === item.value);
      if (option?.disabled === true) return;
      if (this.multiSelect) {
        this.selectedValues.add(item.value);
        this.onConfirm?.(this.getSelectedValues());
      } else {
        this.onSelect(item.value);
      }
    };
    list.onCancel = () => this.onCancel();
    list.onSelectionChange = (item) => this.onPreview?.(item.value);
    return list;
  }

  private replaceList(query: string): void {
    const previousValue = query === this.query ? this.getSelectedValue() : undefined;
    this.query = query;
    const filtered = this.projectOptions(query);
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

  getSelectedValues(): readonly string[] {
    return Object.freeze(this.allOptions
      .filter((option) => this.selectedValues.has(option.value))
      .map((option) => option.value));
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (this.filters.length > 0 && (data === "\t" || data === "\x1b[Z")) {
      this.filterIndex = (this.filterIndex + (data === "\x1b[Z" ? -1 : 1) + this.filters.length)
        % this.filters.length;
      return;
    }
    if (this.filters.length > 0 && this.search.getValue().length === 0) {
      const direction = data === "\x1b[D" ? -1 : data === "\x1b[C" ? 1 : 0;
      if (direction !== 0) {
        const filter = this.filters[this.filterIndex];
        if (filter !== undefined && filter.options.length > 0) {
          const current = Math.max(0, filter.options.findIndex((option) =>
            option.value === this.filterValues[filter.key]));
          const next = (current + direction + filter.options.length) % filter.options.length;
          this.filterValues[filter.key] = filter.options[next]!.value;
          this.replaceList("");
        }
        return;
      }
    }
    if (keybindings.matches(data, "tui.select.pageUp")) {
      this.movePage(-1);
      return;
    }
    if (this.multiSelect && (data === " " || data === "\t")) {
      const value = this.getSelectedValue();
      const option = this.allOptions.find((candidate) => candidate.value === value);
      if (value !== undefined && option?.disabled !== true) {
        if (this.selectedValues.has(value)) this.selectedValues.delete(value);
        else this.selectedValues.add(value);
        this.replaceList(this.search.getValue());
        this.onPreview?.(value);
      }
      return;
    }
    if (this.multiSelect && keybindings.matches(data, "tui.select.confirm")) {
      this.onConfirm?.(this.getSelectedValues());
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
    const subtitle = typeof this.subtitle === "function" ? this.subtitle(this.filteredOptions) : this.subtitle;
    if (subtitle !== undefined && subtitle.trim().length > 0) {
      lines.push(truncateToWidth(nausicaaMarkdownTheme.linkUrl(subtitle), safeWidth, ""));
    }
    const filterRows = [this.searchLabel];
    for (const filter of this.renderFilters(safeWidth)) {
      const lastIndex = filterRows.length - 1;
      const joined = `${filterRows[lastIndex]}    ${filter}`;
      if (visibleWidth(joined) <= safeWidth) filterRows[lastIndex] = joined;
      else filterRows.push(filter);
    }
    lines.push(
      ...filterRows.map((row) => truncateToWidth(row, safeWidth, "")),
      ...this.search.render(safeWidth),
      ...this.list.render(safeWidth),
      truncateToWidth(
        this.multiSelect
          ? "  Up/Down navigate | Space toggle | Enter confirm | Esc cancel"
          : this.filters.length > 0
            ? "  Up/Down navigate | Tab filter | Left/Right change | Enter select | Esc cancel"
            : "  Up/Down navigate | Enter select | Esc cancel",
        safeWidth,
        "",
      ),
    );
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  private renderFilters(width: number): readonly string[] {
    return this.filters.map((filter) => {
      const selected = this.filterValues[filter.key];
      const values = filter.options.map((option) => option.value === selected
        ? `[${option.label}]`
        : option.label);
      const expanded = `${filter.label}: ${values.join(" ")}`;
      // Provider facets can contain dozens of entries. Rendering every option
      // makes the active value disappear on ordinary terminal widths, so keep
      // the compact current-value/count form for long facets while retaining
      // the full toggle strip for small, scannable facets.
      if (filter.options.length > 6 || visibleWidth(expanded) > width) {
        const selectedIndex = Math.max(
          0,
          filter.options.findIndex((option) => option.value === selected),
        );
        const selectedLabel = filter.options[selectedIndex]?.label ?? selected ?? "-";
        return `${filter.label}: [${selectedLabel}] (${selectedIndex + 1}/${filter.options.length})`;
      }
      return expanded;
    });
  }

  override invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }
}
