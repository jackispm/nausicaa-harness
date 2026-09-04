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
      if (options.current !== undefined) {
        const filteredIndex = this.projectOptions(options.initialQuery)
          .findIndex((option) => option.value === options.current);
        if (filteredIndex >= 0) this.list.setSelectedIndex(filteredIndex);
      }
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
    const previousValue = this.getSelectedValue();
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
    if (this.subtitle !== undefined && this.subtitle.trim().length > 0) {
      lines.push(truncateToWidth(nausicaaMarkdownTheme.linkUrl(this.subtitle), safeWidth, ""));
    }
    const filters = this.renderFilters();
    lines.push(
      truncateToWidth(
        filters.length === 0 ? this.searchLabel : `${this.searchLabel}${" ".repeat(4)}${filters}`,
        safeWidth,
        "",
      ),
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

  private renderFilters(): string {
    return this.filters.map((filter) => {
      const selected = this.filterValues[filter.key];
      const values = filter.options.map((option) => option.value === selected
        ? `[${option.label}]`
        : option.label);
      return `${filter.label}: ${values.join(" ")}`;
    }).join("    ");
  }

  override invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }
}
