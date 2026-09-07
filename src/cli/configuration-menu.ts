/**
 * Narrow adaptation of Prime Agent configuration-menu.ts @
 * 7787f07415d843b9a800f6a4720e0c739bd608e5, version 0.7.2.
 * MIT; Copyright (c) 2025 Mario Zechner, (c) 2026 Prime Intellect.
 * The upstream private component couples auth/model services. This adapter
 * keeps its retained-tab contract and injects Nausicaa's existing page owners.
 */
import {
  type Component,
  type Focusable,
  isFocusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { renderAuthPanel } from "./auth-menu.js";
import { nausicaaPalette as palette } from "./tui-components.js";

export const CONFIGURATION_MENU_TABS = ["providers", "models", "mcp", "skills"] as const;
export type ConfigurationMenuTab = (typeof CONFIGURATION_MENU_TABS)[number];

export interface ConfigurationMenuPage {
  component: Component;
  dispose?: () => void;
}

export interface ConfigurationMenuOptions {
  initialTab: ConfigurationMenuTab;
  createPage: (tab: ConfigurationMenuTab) => ConfigurationMenuPage;
  requestRender: () => void;
}

const TAB_LABELS: Readonly<Record<ConfigurationMenuTab, string>> = {
  providers: "Providers",
  models: "Models",
  mcp: "MCP",
  skills: "Skills",
};

function safeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function disposePage(page: ConfigurationMenuPage): void {
  if (isFocusable(page.component)) page.component.focused = false;
  if (page.dispose !== undefined) page.dispose();
  else (page.component as Component & { dispose?: () => void }).dispose?.();
}

/** A retained settings host. Mount the host inside FullScreenMenuPage. */
export class ConfigurationMenu implements Component, Focusable {
  private readonly pages = new Map<ConfigurationMenuTab, ConfigurationMenuPage>();
  private currentTab: ConfigurationMenuTab;
  private _focused = false;
  private disposed = false;
  private renderWidth = 78;

  constructor(private readonly options: ConfigurationMenuOptions) {
    this.currentTab = options.initialTab;
  }

  get activeTab(): ConfigurationMenuTab { return this.currentTab; }
  get focused(): boolean { return this._focused; }

  set focused(value: boolean) {
    if (this.disposed) return;
    const page = value ? this.getPage(this.currentTab) : this.pages.get(this.currentTab);
    if (this.disposed) return;
    this._focused = value;
    if (page !== undefined && isFocusable(page.component)) page.component.focused = value;
  }

  /** Pass this to child getRows callbacks so wrapped navigation reserves its space. */
  getPageRows(totalRows: number): number {
    return Math.max(1, safeDimension(totalRows) - this.renderHeader(this.renderWidth).length);
  }

  setActiveTab(tab: ConfigurationMenuTab): void {
    if (this.disposed || tab === this.currentTab) return;
    const next = this.getPage(tab);
    if (next === undefined || this.disposed) return;
    const previous = this.pages.get(this.currentTab);
    if (previous !== undefined && isFocusable(previous.component)) previous.component.focused = false;
    this.currentTab = tab;
    if (isFocusable(next.component)) next.component.focused = this._focused;
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "ctrl+left") || matchesKey(data, "ctrl+right")) {
      const direction = matchesKey(data, "ctrl+left") ? -1 : 1;
      const index = CONFIGURATION_MENU_TABS.indexOf(this.currentTab);
      const next = (index + direction + CONFIGURATION_MENU_TABS.length) % CONFIGURATION_MENU_TABS.length;
      this.setActiveTab(CONFIGURATION_MENU_TABS[next] ?? "providers");
      return;
    }
    this.getPage(this.currentTab)?.component.handleInput?.(data);
  }

  invalidate(): void {
    if (this.disposed) return;
    for (const page of this.pages.values()) page.component.invalidate();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const columns = safeDimension(width);
    this.renderWidth = columns;
    const page = this.getPage(this.currentTab);
    if (page === undefined || this.disposed) return [];
    return [
      ...this.renderHeader(columns),
      ...page.component.render(columns).map((line) => truncateToWidth(line, columns, "")),
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this._focused = false;
    const pages = [...this.pages.values()];
    this.pages.clear();
    const errors: unknown[] = [];
    for (const page of pages) {
      try { disposePage(page); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Could not dispose every configuration page");
  }

  private getPage(tab: ConfigurationMenuTab): ConfigurationMenuPage | undefined {
    if (this.disposed) return undefined;
    const existing = this.pages.get(tab);
    if (existing !== undefined) return existing;
    const page = this.options.createPage(tab);
    // A factory can synchronously close the host; never retain that late result.
    if (this.disposed) {
      disposePage(page);
      return undefined;
    }
    this.pages.set(tab, page);
    return page;
  }

  private renderHeader(width: number): string[] {
    const columns = safeDimension(width);
    const padding = Math.min(2, Math.floor((columns - 1) / 2));
    const innerWidth = columns - padding * 2;
    const lines: string[] = [];
    let line = "";
    for (const tab of CONFIGURATION_MENU_TABS) {
      const active = tab === this.currentTab;
      const label = `${active ? "[" : " "}${TAB_LABELS[tab]}${active ? "]" : " "}`;
      const styled = active ? palette.strong(palette.text(label)) : palette.menuMuted(label);
      const candidate = line ? `${line}  ${styled}` : styled;
      if (line && visibleWidth(candidate) > innerWidth) {
        lines.push(line);
        line = styled;
      } else line = candidate;
    }
    if (line) lines.push(line);
    // The child panel already supplies the separating padding row.
    return renderAuthPanel([palette.strong(palette.brand("Nausicaa")), ...lines], columns).slice(0, -1);
  }
}
