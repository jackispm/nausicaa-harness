/**
 * Minimal adaptation of Prime Agent's OAuthSelector and MenuPanel/MenuRow:
 * packages/coding-agent/src/modes/interactive/components/{oauth-selector,menu-panel}.ts
 * PrimeIntellect-ai/prime-agent @ 7787f07415d843b9a800f6a4720e0c739bd608e5.
 * MIT License; Copyright (c) 2025 Mario Zechner, (c) 2026 Prime Intellect.
 * Auth execution and storage remain owned by Nausicaa. See THIRD_PARTY_NOTICES.
 */
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { nausicaaPalette as palette } from "./tui-components.js";

export interface AuthMenuChoice {
  value: string;
  label: string;
  detail?: string;
  status?: string;
  searchText?: string;
}

export interface AuthMenuOptions {
  title: string;
  subtitle?: string;
  choices: readonly AuthMenuChoice[];
  current?: string;
  initialQuery?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  headerLines?: readonly string[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  getRows?: () => number;
}

const MAX_VISIBLE_CHOICES = 8;
const HORIZONTAL_PADDING = 2;
const OVERLAY_MARGIN_ROWS = 2;

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function paddingFor(width: number): number {
  return Math.min(HORIZONTAL_PADDING, Math.floor((width - 1) / 2));
}

function innerWidthFor(width: number): number {
  return width - paddingFor(width) * 2;
}

function plainText(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function surfaceLine(text: string, width: number, selected = false): string {
  const padding = " ".repeat(paddingFor(width));
  const innerWidth = innerWidthFor(width);
  const clipped = truncateToWidth(text, innerWidth, "");
  const remaining = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  const background = selected ? palette.userBackground : palette.toolPendingBackground;
  // Foreground resets from Input and truncation must not leave holes in the surface.
  return `${padding}${clipped}${remaining}${padding}`
    .split("\x1b[0m").map((segment) => background(segment)).join("\x1b[0m");
}

/** The same padded surface for the menu and its subsequent login prompts. */
export function renderAuthPanel(
  content: readonly string[],
  width: number,
  selectedRows?: ReadonlySet<number>,
): string[] {
  const columns = safeWidth(width);
  return [
    surfaceLine("", columns),
    ...content.map((line, index) => surfaceLine(line, columns, selectedRows?.has(index))),
    surfaceLine("", columns),
  ];
}

/** A provider/credential picker; values identify authentication methods, not labels. */
export class AuthMenu implements Component, Focusable {
  private readonly input = new Input();
  private choices: readonly AuthMenuChoice[];
  private filtered: readonly AuthMenuChoice[] = [];
  private selectedIndex = 0;
  private query = "";
  private pageSize = MAX_VISIBLE_CHOICES;
  private _focused = false;

  constructor(private readonly options: AuthMenuOptions) {
    this.choices = [...options.choices];
    this.input.setValue(options.searchable === false ? "" : options.initialQuery ?? "");
    this.input.onSubmit = () => this.select();
    this.input.onEscape = options.onCancel;
    this.filter(this.input.getValue());
    if (options.current !== undefined) this.restoreSelection(options.current);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.options.searchable !== false;
  }

  getQuery(): string {
    return this.query;
  }

  getSelectedValue(): string | undefined {
    return this.filtered[this.selectedIndex]?.value;
  }

  setChoices(choices: readonly AuthMenuChoice[]): void {
    const selected = this.getSelectedValue();
    this.choices = [...choices];
    this.filter(this.query);
    if (selected !== undefined) this.restoreSelection(selected);
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.options.onCancel();
    } else if (keys.matches(data, "tui.select.up")) {
      this.move(-1);
    } else if (keys.matches(data, "tui.select.down")) {
      this.move(1);
    } else if (keys.matches(data, "tui.select.pageUp")) {
      this.move(-this.pageSize);
    } else if (keys.matches(data, "tui.select.pageDown")) {
      this.move(this.pageSize);
    } else if (keys.matches(data, "tui.select.confirm")) {
      this.select();
    } else if (this.options.searchable !== false) {
      this.input.handleInput(data);
      this.filter(this.input.getValue());
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const columns = safeWidth(width);
    const rows = this.options.getRows?.();
    const budget = rows !== undefined && Number.isFinite(rows) && rows > 0
      ? Math.max(1, Math.floor(rows) - OVERLAY_MARGIN_ROWS)
      : Number.POSITIVE_INFINITY;
    const compactHeader = budget < 10;
    const header = [palette.strong(palette.text(plainText(this.options.title)))];
    if (!compactHeader && this.options.subtitle) {
      header.push(palette.muted(plainText(this.options.subtitle)));
    }
    header.push(...(this.options.headerLines ?? []).map((line) => palette.muted(plainText(line))));
    if (this.options.searchable !== false) {
      if (!compactHeader) header.push("");
      header.push(this.renderSearch(innerWidthFor(columns)));
    }
    if (!compactHeader) header.push("");

    const fixedRows = header.length + 2;
    const availableRows = Math.max(2, budget - fixedRows);
    const layout = (itemRows: number, paddingRows: number) => {
      const capacity = Math.max(1, Math.min(MAX_VISIBLE_CHOICES,
        Math.floor((availableRows - paddingRows) / itemRows)));
      const scrollRows = this.filtered.length > capacity ? 1 : 0;
      return Math.max(1, Math.min(MAX_VISIBLE_CHOICES,
        Math.floor((availableRows - paddingRows - scrollRows) / itemRows)));
    };
    const comfortableCount = layout(3, 1);
    const compactCount = layout(2, 0);
    const comfortableFits = comfortableCount * 3 + 1
      + (this.filtered.length > comfortableCount ? 1 : 0) <= availableRows;
    const compact = compactCount > comfortableCount || !comfortableFits;
    this.pageSize = compact ? compactCount : comfortableCount;
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(this.pageSize / 2),
      this.filtered.length - this.pageSize,
    ));
    const visible = this.filtered.slice(start, start + this.pageSize);
    const lines = [surfaceLine("", columns), ...header.map((line) => surfaceLine(line, columns))];

    if (visible.length === 0) {
      lines.push(surfaceLine(palette.muted(plainText(this.options.emptyMessage ?? (this.choices.length === 0
        ? "No providers available" : "No matching providers"))), columns));
    } else {
      for (const [offset, choice] of visible.entries()) {
        const selected = start + offset === this.selectedIndex;
        if (!compact) {
          lines.push(surfaceLine("", columns, selected || start + offset - 1 === this.selectedIndex));
        }
        lines.push(...this.renderChoice(choice, columns, selected));
      }
      if (!compact) {
        lines.push(surfaceLine("", columns, start + visible.length - 1 === this.selectedIndex));
      }
      if (this.filtered.length > visible.length) {
        lines.push(surfaceLine(palette.muted(`(${this.selectedIndex + 1}/${this.filtered.length})`), columns));
      }
    }
    lines.push(surfaceLine("", columns));
    return lines.slice(0, budget);
  }

  private renderSearch(width: number): string {
    if (this.query === "") {
      return `${this.focused ? CURSOR_MARKER : ""}${palette.dim(plainText(this.options.searchPlaceholder ?? "Search providers"))}`;
    }
    const line = this.input.render(width + 2)[0] ?? "";
    return line.startsWith("> ") ? line.slice(2) : line;
  }

  private renderChoice(choice: AuthMenuChoice, width: number, selected: boolean): string[] {
    const innerWidth = innerWidthFor(width);
    const name = plainText(choice.label);
    const status = plainText(choice.status ?? "");
    const gap = 2;
    const minimumNameWidth = Math.min(visibleWidth(name), Math.max(12, innerWidth - gap - 6));
    const statusWidth = Math.max(0, innerWidth - minimumNameWidth - gap);
    const shownStatus = statusWidth >= 4 ? truncateToWidth(status, statusWidth, "...") : "";
    const nameWidth = innerWidth - (shownStatus ? visibleWidth(shownStatus) + gap : 0);
    const shownName = truncateToWidth(name, nameWidth, "...");
    const padding = shownStatus ? " ".repeat(Math.max(gap, innerWidth - visibleWidth(shownName) - visibleWidth(shownStatus))) : "";
    const primary = selected ? palette.strong(palette.text(shownName)) : palette.text(shownName);
    return [
      surfaceLine(primary + padding + palette.muted(shownStatus), width, selected),
      surfaceLine(palette.muted(plainText(choice.detail ?? "")), width, selected),
    ];
  }

  private filter(query: string): void {
    const changed = query !== this.query;
    this.query = query;
    this.filtered = query ? fuzzyFilter([...this.choices], query, (choice) =>
      `${plainText(choice.label)} ${choice.value} ${plainText(choice.detail ?? "")} ${plainText(choice.searchText ?? "")}`)
      : this.choices;
    this.selectedIndex = changed ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
  }

  private restoreSelection(value: string): void {
    const index = this.filtered.findIndex((choice) => choice.value === value);
    if (index >= 0) this.selectedIndex = index;
  }

  private move(delta: number): void {
    this.selectedIndex = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
  }

  private select(): void {
    const selected = this.getSelectedValue();
    if (selected !== undefined) this.options.onSelect(selected);
  }
}
