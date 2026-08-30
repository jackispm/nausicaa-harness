import {
  Box,
  Container,
  type EditorTheme,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
  type Component,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type {
  SessionContextOverview,
  SessionSnapshot,
  WorkerTaskSummary,
} from "../runtime/index.js";
import {
  renderToolPresentation,
  type ToolPresentationLine,
} from "./tool-renderers.js";

const ESC = "\x1b[";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type ColorScheme = "light" | "dark";

interface ThemePalette {
  accent: (text: string) => string;
  accentBright: (text: string) => string;
  info: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  muted: (text: string) => string;
  strong: (text: string) => string;
  dim: (text: string) => string;
  thinking: (text: string) => string;
  text: (text: string) => string;
  userBackground: (text: string) => string;
  toolBackground: (text: string) => string;
  adviceBackground: (text: string) => string;
  promptBackground: (text: string) => string;
}

function style(code: string, close: string, text: string): string {
  return `${ESC}${code}m${text}${ESC}${close}m`;
}

function fg(code: string, text: string): string {
  return style(code, "39", text);
}

function bg(code: string, text: string): string {
  return style(code, "49", text);
}

const lightPalette: ThemePalette = {
  accent: (text) => fg("38;2;90;128;128", text),
  accentBright: (text) => fg("38;2;63;110;110", text),
  info: (text) => fg("38;2;84;125;167", text),
  success: (text) => fg("38;2;88;132;88", text),
  warning: (text) => fg("38;2;154;115;38", text),
  error: (text) => fg("38;2;170;85;85", text),
  muted: (text) => fg("38;2;108;108;108", text),
  strong: (text) => style("1", "22", text),
  dim: (text) => fg("38;2;118;118;118", text),
  thinking: (text) => fg("38;2;122;122;122", text),
  text: (text) => text,
  userBackground: (text) => bg("48;2;232;232;232", text),
  toolBackground: (text) => bg("48;2;237;237;242", text),
  adviceBackground: (text) => bg("48;2;235;240;238", text),
  promptBackground: (text) => bg("48;2;232;232;232", text),
};

const darkPalette: ThemePalette = {
  accent: (text) => fg("38;5;141", text),
  accentBright: (text) => fg("38;5;183", text),
  info: (text) => fg("38;5;81", text),
  success: (text) => fg("38;5;114", text),
  warning: (text) => fg("38;5;215", text),
  error: (text) => fg("38;5;174", text),
  muted: (text) => fg("38;5;145", text),
  strong: (text) => style("1", "22", text),
  dim: (text) => fg("38;5;103", text),
  thinking: (text) => fg("38;5;145", text),
  text: (text) => fg("97", text),
  userBackground: (text) => bg("48;2;26;26;31", text),
  toolBackground: (text) => bg("48;2;13;13;16", text),
  adviceBackground: (text) => bg("48;2;23;30;29", text),
  promptBackground: (text) => bg("48;2;26;26;31", text),
};

// Theme functions are intentionally stable references. A terminal scheme change
// swaps their backing palette and invalidates the mounted TUI tree.
let activePalette: ThemePalette = lightPalette;

export function setNausicaaColorScheme(scheme: ColorScheme): void {
  activePalette = scheme === "dark" ? darkPalette : lightPalette;
}

export function getNausicaaColorScheme(): ColorScheme {
  return activePalette === darkPalette ? "dark" : "light";
}

const palette: ThemePalette = {
  accent: (text) => activePalette.accent(text),
  accentBright: (text) => activePalette.accentBright(text),
  info: (text) => activePalette.info(text),
  success: (text) => activePalette.success(text),
  warning: (text) => activePalette.warning(text),
  error: (text) => activePalette.error(text),
  muted: (text) => activePalette.muted(text),
  strong: (text) => activePalette.strong(text),
  dim: (text) => activePalette.dim(text),
  thinking: (text) => activePalette.thinking(text),
  text: (text) => activePalette.text(text),
  userBackground: (text) => activePalette.userBackground(text),
  toolBackground: (text) => activePalette.toolBackground(text),
  adviceBackground: (text) => activePalette.adviceBackground(text),
  promptBackground: (text) => activePalette.promptBackground(text),
};

export const nausicaaEditorTheme: EditorTheme = {
  // The published pi-tui Editor still renders border glyphs. Returning a
  // space lets PromptSurface turn those rows into a flat background surface.
  borderColor: () => " ",
  selectList: {
    selectedPrefix: palette.accentBright,
    selectedText: palette.accentBright,
    description: palette.muted,
    scrollInfo: palette.muted,
    noMatch: palette.muted,
  },
};

export const nausicaaMarkdownTheme: MarkdownTheme = {
  heading: palette.accentBright,
  link: palette.info,
  linkUrl: palette.muted,
  code: palette.info,
  codeBlock: palette.info,
  codeBlockBorder: palette.muted,
  quote: palette.muted,
  quoteBorder: palette.muted,
  hr: palette.muted,
  listBullet: palette.accent,
  bold: palette.strong,
  italic: (text) => style("3", "23", text),
  strikethrough: (text) => style("9", "29", text),
  underline: (text) => style("4", "24", text),
  highlightCode: (code) => code.split("\n").map((line) => palette.info(line)),
};

const nausicaaThinkingMarkdownTheme: MarkdownTheme = {
  ...nausicaaMarkdownTheme,
  heading: palette.thinking,
  link: palette.thinking,
  linkUrl: palette.dim,
  code: palette.thinking,
  codeBlock: palette.thinking,
  codeBlockBorder: palette.dim,
  quote: palette.thinking,
  quoteBorder: palette.dim,
  hr: palette.dim,
  listBullet: palette.thinking,
  bold: (text) => palette.strong(palette.thinking(text)),
  highlightCode: (code) => code.split("\n").map((line) => palette.thinking(line)),
};

/** A compact wind-wing mark; deliberately distinct from Prime's butterfly. */
export const NAUSICAA_LOGO = `                         ▄▄
                    ▄▄████
               ▄▄███████▀
  ▄▄▄▄▄▄▄▄▄▄█████████▀
    ▀▀████████████▀▀
        ▀▀████▀▀
         ▄████▄
       ▄██▀  ▀██▄
     ▄██▀      ▀██▄
    ▀▀            ▀▀`;

export interface BrandSplashHeaderOptions {
  version?: string;
  getModel?: () => string;
  getWorkspace?: () => string;
  startHint?: string;
  logo?: string;
}

/** Prime-style startup surface. It becomes compact automatically on narrow terminals. */
export class BrandSplashHeader implements Component {
  private readonly logo: string[];
  private readonly logoWidth: number;
  private compact = false;

  constructor(private readonly options: BrandSplashHeaderOptions = {}) {
    this.logo = (options.logo ?? NAUSICAA_LOGO).split("\n");
    this.logoWidth = this.logo.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  }

  setCompact(compact: boolean): void { this.compact = compact; }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const padding = safeWidth > 2 ? 1 : 0;
    const contentWidth = Math.max(1, safeWidth - padding * 2);
    if (this.compact) {
      const summary = [
        palette.strong(palette.text("Nausicaa")),
        palette.dim(`v${this.options.version ?? "0.1.0"}`),
        palette.muted(this.options.getModel?.() ?? "—"),
        palette.dim(truncatePathMiddle(
          this.options.getWorkspace?.() ?? "",
          Math.max(8, Math.floor(contentWidth / 3)),
        )),
      ].join(` ${palette.dim("·")} `);
      return ["", padLine(truncateToWidth(summary, contentWidth, ""), safeWidth, padding)];
    }
    const gutter = 4;
    const labelWidth = 9;
    const metadataWidth = contentWidth - this.logoWidth - gutter;
    const valueWidth = Math.max(1, metadataWidth - labelWidth);
    const labelled = (label: string, value: string): string => {
      const display = label === "cwd"
        ? truncatePathMiddle(value, valueWidth)
        : truncateToWidth(value, valueWidth, "");
      return `${palette.dim(label.padEnd(labelWidth))}${palette.muted(display)}`;
    };
    const metadata = [
      labelled("version", `v${this.options.version ?? "0.1.0"}`),
      labelled("model", this.options.getModel?.() ?? "—"),
      labelled("cwd", this.options.getWorkspace?.() ?? ""),
      "",
      palette.dim(truncateToWidth(
        this.options.startHint ?? 'Type a task, or "/help" for commands',
        Math.max(1, metadataWidth),
        "",
      )),
    ];
    const showMetadata = metadataWidth >= labelWidth + 8;
    const lines: string[] = [""];
    if (showMetadata) {
      const start = Math.max(0, Math.floor((this.logo.length - metadata.length) / 2));
      this.logo.forEach((logoLine, index) => {
        const meta = index >= start && index < start + metadata.length
          ? metadata[index - start]
          : "";
        const gap = " ".repeat(Math.max(0, this.logoWidth - visibleWidth(logoLine) + gutter));
        const line = truncateToWidth(`${palette.text(logoLine)}${gap}${meta}`, contentWidth, "");
        lines.push(padLine(line, safeWidth, padding));
      });
    } else {
      lines.push(padLine(palette.strong(palette.text("Nausicaa")), safeWidth, padding));
      lines.push(padLine(palette.muted(`${this.options.getModel?.() ?? "—"} · ${truncatePathMiddle(this.options.getWorkspace?.() ?? "", Math.max(8, contentWidth - 4))}`), safeWidth, padding));
    }
    return lines;
  }

  invalidate(): void {}
}

/** Fixed dock tray: lane topology on the left, Main context capacity on the right. */
export class SessionTray implements Component {
  constructor(
    private readonly readSnapshot: () => SessionSnapshot,
    private readonly readTransientStatus: () => string | undefined = () => undefined,
  ) {}

  render(width: number): string[] {
    const snapshot = this.readSnapshot();
    const safeWidth = Math.max(1, width);
    const state = snapshot.status === "detached" ? "new" : snapshot.status;
    const lanes = ["main"];
    if (snapshot.tetoEnabled) lanes.push("Teto");
    if (snapshot.workerEnabled) lanes.push("Worker");
    const topology = `${lanes.join(" + ")}/${state}`;
    const transientStatus = this.readTransientStatus();
    const controls = [
      snapshot.collaborationMode === "plan" ? "plan" : undefined,
      permissionLabel(snapshot.permissionProfile),
    ].filter((value): value is string => value !== undefined).join(" · ");
    const left = transientStatus === undefined
      ? ` ← ${topology}   ${shortModel(snapshot.model)}   ${controls}`
      : ` ← ${terminalSafeText(transientStatus)}`;
    const contextPercent = snapshot.mainContextTokens === null
      || snapshot.mainContextWindowTokens === null
      ? undefined
      : formatTrayContextPercent(
          (snapshot.mainContextTokens / snapshot.mainContextWindowTokens) * 100,
        );
    const right = snapshot.mainContextTokens === null
      ? ""
      : snapshot.mainContextWindowTokens === null
        ? `${formatTokens(snapshot.mainContextTokens)}/? `
        : `${formatTokens(snapshot.mainContextTokens)}/${formatTokens(snapshot.mainContextWindowTokens)} (${contextPercent}%) `;
    return [alignLine(palette.muted(left), palette.dim(right), safeWidth)];
  }

  invalidate(): void {}
}

/** Prime-aligned detail view: current Main capacity is not cumulative spend. */
export class ContextUsageBlock implements Component {
  constructor(private readonly overview: SessionContextOverview) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = [
      palette.strong("Context"),
      "",
      `${palette.dim("Model:")} ${palette.muted(terminalSafeText(this.overview.model))}`,
      formatCurrentContext(this.overview.currentContext, safeWidth),
      "",
      palette.strong("Cumulative usage"),
      "",
      ...formatLaneUsageTable(this.overview, safeWidth),
      "",
      `${palette.dim("Input:")} ${formatExactTokens(this.overview.usage.input)}`,
      `${palette.dim("Output:")} ${formatExactTokens(this.overview.usage.output)}`,
      `${palette.dim("Cache read:")} ${formatExactTokens(this.overview.usage.cacheRead)}`,
      `${palette.dim("Cache write:")} ${formatExactTokens(this.overview.usage.cacheWrite)}`,
      `${palette.dim("Total:")} ${formatExactTokens(spentTokens(this.overview.usage))}`,
      ...(this.overview.usage.costUsd === undefined
        ? []
        : [`${palette.dim("Cost:")} $${this.overview.usage.costUsd.toFixed(4)}`]),
    ];
    return fitLines(lines, safeWidth);
  }

  invalidate(): void {}
}

function formatCurrentContext(
  context: SessionContextOverview["currentContext"],
  width: number,
): string {
  if (context.tokens === null) {
    return `${palette.dim("Current context:")} ${palette.muted("not measured yet")}`;
  }
  if (context.contextWindowTokens === null || context.percent === null) {
    return `${palette.dim("Current context:")} ${formatExactTokens(context.tokens)} / ${palette.muted("unknown")}`;
  }
  const percent = `${context.percent.toFixed(1)}%`;
  const detail = `${formatTokens(context.tokens)}/${formatTokens(context.contextWindowTokens)}`;
  const filled = Math.max(0, Math.min(10, Math.round(context.percent / 10)));
  const bar = palette.accent("▓".repeat(filled)) + palette.dim("░".repeat(10 - filled));
  const value = width >= 48
    ? `${bar} ${percent} ${palette.dim(`(${detail})`)}`
    : `${percent} ${palette.dim(`(${detail})`)}`;
  return `${palette.dim("Current context:")} ${value}`;
}

function formatLaneUsageTable(
  overview: SessionContextOverview,
  width: number,
): string[] {
  if (width < 42) {
    return overview.lanes.map((lane) => {
      const cost = lane.usage.costUsd === undefined ? "" : ` · $${lane.usage.costUsd.toFixed(2)}`;
      return `${terminalSafeText(lane.laneId)} · ${formatTokens(spentTokens(lane.usage))} tokens${cost}`;
    });
  }
  const tokenCells = overview.lanes.map((lane) => formatTokens(spentTokens(lane.usage)));
  const costCells = overview.lanes.map((lane) => (
    lane.usage.costUsd === undefined ? "-" : `$${lane.usage.costUsd.toFixed(2)}`
  ));
  const tokenWidth = Math.max("tokens".length, ...tokenCells.map((value) => value.length));
  const costWidth = Math.max("cost".length, ...costCells.map((value) => value.length));
  const laneWidth = Math.max(8, Math.min(
    24,
    width - tokenWidth - costWidth - 8,
  ));
  const lines = [palette.dim(
    `  ${padVisibleEnd("lane", laneWidth)}  ${padVisibleStart("tokens", tokenWidth)}  ${padVisibleStart("cost", costWidth)}`,
  )];
  for (const [index, lane] of overview.lanes.entries()) {
    const label = truncateToWidth(terminalSafeText(lane.laneId), laneWidth, "...");
    lines.push(
      `  ${padVisibleEnd(label, laneWidth)}  ${padVisibleStart(tokenCells[index] ?? "0", tokenWidth)}  ${palette.dim(padVisibleStart(costCells[index] ?? "-", costWidth))}`,
    );
  }
  return lines;
}

function spentTokens(usage: SessionContextOverview["usage"]): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatExactTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function padVisibleEnd(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function padVisibleStart(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - visibleWidth(value)))}${value}`;
}

function permissionLabel(profile: SessionSnapshot["permissionProfile"]): string {
  switch (profile) {
    case "read-only": return "read only";
    case "workspace": return "workspace";
    case "full-access": return "full access";
    case "custom": return "custom permissions";
  }
}

/** A quiet, durable summary of Worker tasks in the attached Run. */
export class WorkerTaskSummaryLine implements Component {
  constructor(private readonly readSummary: () => WorkerTaskSummary) {}

  render(width: number): string[] {
    const summary = this.readSummary();
    if (summary.total === 0) return [];

    const states: Array<[keyof Omit<WorkerTaskSummary, "total">, number]> = [
      ["queued", summary.queued],
      ["running", summary.running],
      ["ready", summary.ready],
      ["done", summary.done],
      ["failed", summary.failed],
      ["stale", summary.stale],
    ];
    const taskLabel = summary.total === 1 ? "task" : "tasks";
    const text = [
      `${summary.total} Worker ${taskLabel}`,
      ...states
        .filter(([, count]) => count > 0)
        .map(([state, count]) => `${count} ${state}`),
    ].join(" · ");
    return [palette.dim(truncateToWidth(text, Math.max(1, width), "…"))];
  }

  invalidate(): void {}
}

/** Prime-like loader outside the transcript. */
export class ActivityLine implements Component {
  private frame = 0;
  private startedAt: number | undefined;
  private phase = "Thinking";

  constructor(private readonly readSnapshot: () => SessionSnapshot) {}

  advance(): void { this.frame += 1; }

  setPhase(phase: "Thinking" | "Writing" | "Executing"): void {
    this.phase = phase;
  }

  render(width: number): string[] {
    const snapshot = this.readSnapshot();
    const active = snapshot.status === "running" || snapshot.status === "cancelling";
    if (!active) {
      this.startedAt = undefined;
      return [];
    }
    this.startedAt ??= Date.now();
    const spinner = ["·", "✦", "✧", "·"][this.frame % 4] ?? "·";
    const elapsed = formatElapsed(Date.now() - this.startedAt);
    const usage = snapshot.usage.input + snapshot.usage.output;
    const label = snapshot.status === "cancelling" ? "Cancelling" : this.phase;
    return [truncateToWidth(` ${palette.accent(spinner)} ${palette.strong(label)} ${palette.muted("·")} ${palette.muted(`${elapsed} · ${usage} tokens · step ${snapshot.lastCommittedStep}`)}`, Math.max(1, width), "")];
  }

  invalidate(): void {}
}

/** A user turn is a full-width quiet surface with no noisy role heading. */
export class UserMessageBlock extends Container {
  constructor(text: string, imageTypes: readonly string[] = []) {
    super();
    const box = new ResponsiveBox(2, 1, palette.userBackground);
    if (imageTypes.length > 0) {
      const types = [...new Set(imageTypes.map(shortImageType))].join(", ");
      box.addChild(new Text(
        palette.muted(`${imageTypes.length} image${imageTypes.length === 1 ? "" : "s"} · ${types}`),
        0,
        0,
      ));
    }
    const safeText = terminalSafeText(text).trim();
    if (safeText.length > 0) {
      box.addChild(new Markdown(safeText, 0, 0, nausicaaMarkdownTheme));
    }
    this.addChild(box);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    return markSemanticPrompt(lines);
  }
}

function shortImageType(mediaType: string): string {
  return terminalSafeText(mediaType).replace(/^image\//, "").toUpperCase();
}

export class ThinkingRow implements Component {
  private expanded = true;
  private text = "";
  private readonly markdown = new Markdown(
    "",
    1,
    0,
    nausicaaThinkingMarkdownTheme,
    { color: palette.thinking },
  );

  setText(text: string): void {
    this.text = terminalSafeText(text).trim();
    this.markdown.setText(this.text);
  }
  setStreaming(_streaming: boolean): void {}
  setExpanded(expanded: boolean): void { this.expanded = expanded; }
  toggle(): void { this.expanded = !this.expanded; }

  render(width: number): string[] {
    if (this.text.trim().length === 0) return [];
    const safeWidth = Math.max(1, width);
    const label = palette.strong(palette.thinking("Thinking..."));
    const hint = this.expanded ? "Ctrl+T to collapse" : "Ctrl+T to expand";
    if (!this.expanded) {
      const recap = thinkingRecap(this.text, "working");
      return [truncateToWidth(` ${label} ${palette.dim("·")} ${palette.thinking(recap)} ${palette.dim(`(${hint})`)}`, safeWidth, "")];
    }
    return [
      truncateToWidth(` ${label} ${palette.dim(`(${hint})`)}`, safeWidth, ""),
      ...this.markdown.render(safeWidth),
    ];
  }

  invalidate(): void { this.markdown.invalidate(); }
}

/** Flat assistant Markdown plus an independently collapsible reasoning row. */
export class AssistantMessageBlock implements Component {
  private readonly thinking = new ThinkingRow();
  private readonly markdown: Markdown;
  private text = "";
  private hasToolCalls: boolean;

  constructor(text = "", hasToolCalls = false) {
    this.markdown = new Markdown("", 1, 0, nausicaaMarkdownTheme);
    this.hasToolCalls = hasToolCalls;
    this.setText(text);
  }

  setText(text: string): void {
    this.text = terminalSafeText(text).trim();
    this.markdown.setText(this.text);
  }

  setThinking(text: string, streaming = true): void {
    this.thinking.setText(text);
    this.thinking.setStreaming(streaming);
    this.thinking.invalidate();
  }

  setHasToolCalls(hasToolCalls: boolean): void { this.hasToolCalls = hasToolCalls; }

  toggleThinking(): void { this.thinking.toggle(); }
  setThinkingExpanded(expanded: boolean): void { this.thinking.setExpanded(expanded); }
  getText(): string { return this.text; }
  hasVisibleContent(): boolean {
    return (!this.hasToolCalls && this.text.length > 0) || this.thinking.render(1).length > 0;
  }

  render(width: number): string[] {
    const thinking = this.thinking.render(width);
    // Some providers occasionally attach narration to a tool-call response.
    // Keep it in the Ledger/model context, but do not present it as an answer.
    const answer = this.hasToolCalls || this.text.length === 0
      ? []
      : this.markdown.render(width);
    const lines = fitLines([
      ...thinking,
      ...(thinking.length > 0 && answer.length > 0 ? [""] : []),
      ...answer,
    ], width);
    return this.hasToolCalls ? lines : markSemanticPrompt(lines);
  }

  invalidate(): void {
    this.thinking.invalidate();
    this.markdown.invalidate();
  }
}

function formatTrayContextPercent(percent: number): string {
  if (percent > 0 && percent < 1) return percent.toFixed(1);
  return String(Math.round(percent));
}

function markSemanticPrompt(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const marked = [...lines];
  marked[0] = OSC133_ZONE_START + marked[0];
  const last = marked.length - 1;
  marked[last] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[last];
  return marked;
}

export type ToolStatus = "running" | "succeeded" | "failed" | "unknown" | "archived";

/** Full-width tool panel: compact header by default, arguments/results on demand. */
export class ToolStatusBlock implements Component {
  private status: ToolStatus;
  private detail = "";
  private argumentsText = "";
  private resultText = "";
  private expanded = false;
  private showExpandHint = true;
  private frame = 0;
  private cachedRender: { width: number; lines: string[] } | undefined;

  private readonly toolName: string;

  constructor(toolName: string, status: ToolStatus, detail = "") {
    this.toolName = terminalSafeText(toolName).trim() || "unknown_tool";
    this.status = status;
    this.detail = terminalSafeText(detail);
  }

  setStatus(status: ToolStatus, detail = ""): void {
    this.status = status;
    if (detail.length > 0) this.detail = terminalSafeText(detail);
    this.invalidate();
  }

  setArguments(value: string): void {
    this.argumentsText = terminalSafeText(value);
    this.invalidate();
  }
  setResult(value: string): void {
    this.resultText = terminalSafeText(value);
    this.invalidate();
  }
  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.invalidate();
  }
  setShowExpandHint(show: boolean): void {
    if (this.showExpandHint === show) return;
    this.showExpandHint = show;
    this.invalidate();
  }
  toggle(): void {
    this.expanded = !this.expanded;
    this.invalidate();
  }
  advance(): void {
    if (this.status !== "running") return;
    this.frame += 1;
    this.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.cachedRender?.width === safeWidth) return this.cachedRender.lines;
    const status = this.statusPresentation();
    const presentation = renderToolPresentation({
      name: this.toolName,
      ...(this.argumentsText.length === 0 ? {} : { arguments: this.argumentsText }),
      ...(this.resultText.length === 0 ? {} : { result: this.resultText }),
      status: this.status,
      width: toolPanelContentWidth(safeWidth),
    });
    const marker = `${status.color(status.marker)} `;
    const detail = [presentation.summary, this.detail]
      .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
      .join(" · ");
    const canExpand = presentationsDiffer(presentation.collapsed, presentation.expanded)
      || (
        this.status === "unknown"
        && this.argumentsText.length > 0
        && presentation.expanded.length === 0
      );
    const expandHint = this.showExpandHint && canExpand
      ? ` ${palette.dim(`· (Ctrl+O to ${this.expanded ? "collapse" : "expand"})`)}`
      : "";
    const header = `${marker}${palette.strong(this.toolName)} ${palette.dim("·")} ${status.color(status.label)}${expandHint}${detail ? ` ${palette.dim(`· ${oneLine(detail, 100)}`)}` : ""}`;
    const lines = [toolPanelLine(header, safeWidth)];
    const body = this.expanded ? presentation.expanded : presentation.collapsed;
    if (body.length > 0) {
      lines.push(toolPanelLine("", safeWidth));
      lines.push(...body.map((line) => toolPanelLine(styleToolLine(line), safeWidth)));
    }
    // An unresolved operation must remain inspectable even for a specialized
    // renderer that normally hides large call arguments.
    if (
      this.expanded
      && this.status === "unknown"
      && this.argumentsText.length > 0
      && presentation.expanded.length === 0
    ) {
      lines.push(toolPanelLine("", safeWidth));
      lines.push(...toolPanelBody("arguments", this.argumentsText, safeWidth));
    }
    this.cachedRender = { width: safeWidth, lines };
    return lines;
  }

  invalidate(): void { this.cachedRender = undefined; }

  private statusPresentation(): { marker: string; label: string; color: (text: string) => string } {
    switch (this.status) {
      case "running": return { marker: ["·", "✦", "✧", "·"][this.frame % 4] ?? "·", label: "running", color: palette.warning };
      case "succeeded": return { marker: "✓", label: "done", color: palette.success };
      case "failed": return { marker: "!", label: "error", color: palette.error };
      case "unknown": return { marker: "?", label: "unknown", color: palette.error };
      case "archived": return { marker: "-", label: "archived", color: palette.muted };
    }
  }
}

/** Match Prime's convention: only the newest tool advertises the global toggle. */
export function selectLatestToolExpandHint(
  existing: readonly ToolStatusBlock[],
  latest: ToolStatusBlock,
): void {
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const component = existing[index];
    if (component === undefined || component === latest) continue;
    component.setShowExpandHint(false);
    break;
  }
  latest.setShowExpandHint(true);
}

function presentationsDiffer(
  collapsed: readonly ToolPresentationLine[],
  expanded: readonly ToolPresentationLine[],
): boolean {
  if (collapsed.length !== expanded.length) return true;
  return collapsed.some((line, index) => {
    const other = expanded[index];
    return other === undefined || line.text !== other.text || line.tone !== other.tone;
  });
}

function styleToolLine(line: ToolPresentationLine): string {
  switch (line.tone) {
    case "output": return palette.muted(line.text);
    case "muted": return palette.dim(line.text);
    case "warning": return palette.warning(line.text);
    case "error": return palette.error(line.text);
    case "added": return palette.success(line.text);
    case "removed": return palette.error(line.text);
    case "context": return palette.dim(line.text);
  }
}

export class AdviceBlock extends Container {
  constructor(claim: string, suggestedAction?: string, confidence?: number) {
    super();
    const box = new ResponsiveBox(2, 1, palette.adviceBackground);
    const score = confidence === undefined ? "" : ` ${Math.round(confidence * 100)}%`;
    box.addChild(new Text(`${palette.accentBright(palette.strong("Teto"))}${palette.dim(" · intent navigator")}${palette.muted(score)}`, 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(terminalSafeText(claim).trim(), 0, 0, nausicaaMarkdownTheme));
    if (suggestedAction?.trim()) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(`${palette.warning("suggestion")} ${terminalSafeText(suggestedAction).trim()}`, 0, 0));
    }
    this.addChild(box);
  }
}

export class NoticeBlock implements Component {
  private readonly message: string;

  constructor(
    message: string,
    private readonly kind: "info" | "success" | "warning" | "error" = "info",
  ) {
    this.message = terminalSafeText(message);
  }

  render(width: number): string[] {
    const color = this.kind === "success"
      ? palette.success
      : this.kind === "warning"
        ? palette.warning
        : this.kind === "error"
          ? palette.error
          : palette.info;
    return [truncateToWidth(` ${color("│")} ${this.message}`, Math.max(1, width), "")];
  }

  invalidate(): void {}
}

export interface QueuePreviewItem {
  delivery: "steering" | "follow-up";
  text: string;
}

export class QueuePreview implements Component {
  private items: QueuePreviewItem[] = [];
  setItems(items: readonly QueuePreviewItem[]): void { this.items = [...items]; }

  render(width: number): string[] {
    if (this.items.length === 0) return [];
    const safeWidth = Math.max(1, width);
    const lines = [truncateToWidth(`${palette.dim("queued")}${palette.muted(" · ")}${palette.dim("Alt+Enter add follow-up")}`, safeWidth, "")];
    for (const item of this.items) {
      const label = item.delivery === "steering" ? "steer" : "follow-up";
      lines.push(truncateToWidth(` ${palette.accent("›")} ${palette.muted(label)} ${palette.text(oneLine(terminalSafeText(item.text), Math.max(8, safeWidth - label.length - 6)))}`, safeWidth, ""));
    }
    return lines;
  }

  invalidate(): void {}
}

interface PromptEditor extends Component {
  getText?: () => string;
}

export class PromptSurface implements Component {
  constructor(
    private readonly editor: PromptEditor,
    private readonly placeholder = 'Try "inspect this project"',
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = this.editor.render(safeWidth);
    if (lines.length >= 3 && safeWidth >= 5) {
      const prefix = palette.accent("> ");
      const prefixWidth = visibleWidth(prefix);
      const editorRow = lines[1] ?? "";
      const content = sliceByColumn(
        editorRow,
        prefixWidth,
        Math.max(1, safeWidth - prefixWidth),
        true,
      );
      if (this.editor.getText?.().length === 0) {
        const cursor = sliceByColumn(content, 0, 1, true);
        const available = Math.max(0, safeWidth - prefixWidth - 1);
        lines[1] = `${prefix}${cursor}${palette.dim(truncateToWidth(this.placeholder, available, ""))}`;
      } else {
        lines[1] = `${prefix}${content}`;
      }
    }
    return lines.map((line) => backgroundLine(line, safeWidth, palette.promptBackground));
  }

  invalidate(): void { this.editor.invalidate(); }
}

class ResponsiveBox implements Component {
  private readonly box: Box;
  private readonly fallback = new Container();

  constructor(private readonly paddingX: number, paddingY: number, bgFn: (text: string) => string) {
    this.box = new Box(paddingX, paddingY, bgFn);
  }

  addChild(component: Component): void {
    this.box.addChild(component);
    this.fallback.addChild(component);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return safeWidth <= this.paddingX * 2 ? this.fallback.render(safeWidth) : this.box.render(safeWidth);
  }

  invalidate(): void { this.box.invalidate(); this.fallback.invalidate(); }
}

function toolPanelLine(line: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const padding = safeWidth >= 5 ? 2 : 0;
  const inner = toolPanelContentWidth(safeWidth);
  const content = `${" ".repeat(padding)}${truncateToWidth(line, inner, "")}`;
  return backgroundLine(content, safeWidth, palette.toolBackground);
}

function toolPanelContentWidth(width: number): number {
  const safeWidth = Math.max(1, width);
  return Math.max(1, safeWidth - (safeWidth >= 5 ? 4 : 0));
}

function toolPanelBody(label: string, text: string, width: number): string[] {
  const lines = [toolPanelLine(palette.dim(label), width)];
  const wrapped = boundedWrap(text, Math.max(1, width - 4), 200);
  for (const line of wrapped.lines) {
    lines.push(toolPanelLine(palette.muted(line), width));
  }
  if (wrapped.truncated) {
    lines.push(toolPanelLine(palette.dim("… more output"), width));
  }
  return lines;
}

function boundedWrap(
  text: string,
  width: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const source = text.trim();
  const sourceBudget = Math.max(1_024, width * maxLines * 2);
  const sample = source.slice(0, sourceBudget);
  const wrapped = wrapTextWithAnsi(sample, width);
  return {
    lines: wrapped.slice(0, maxLines),
    truncated: sample.length < source.length || wrapped.length > maxLines,
  };
}

export function thinkingRecap(thinking: string, fallback: string, maxWidth = 80): string {
  const lines = thinking.split("\n").map((line) => line.trim()).filter(Boolean);
  const source = [...lines].reverse().find((line) => /^#{1,6}\s+\S/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line)) ?? lines[0] ?? fallback;
  const plain = source.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/:$/, "").trim();
  return truncateToWidth(plain || fallback, Math.max(8, maxWidth), "");
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function truncatePathMiddle(value: string, maxWidth: number): string {
  const normalized = value.replaceAll("\\", "/");
  if (visibleWidth(normalized) <= maxWidth) return normalized;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return truncateToWidth(normalized, maxWidth, "...");
  return truncateToWidth(`.../${parts.slice(-2).join("/")}`, maxWidth, "...");
}

function padLine(line: string, width: number, padding: number): string {
  const contentWidth = Math.max(1, width - padding * 2);
  const clipped = truncateToWidth(line, contentWidth, "");
  return `${" ".repeat(padding)}${clipped}${" ".repeat(Math.max(0, width - padding - visibleWidth(clipped)))}`;
}

function oneLine(value: string, maxWidth = 160): string {
  return truncateToWidth(value.replace(/\s+/g, " ").trim(), Math.max(1, maxWidth), "...");
}

/** Remove terminal control sequences before rendering model or tool text. */
export function terminalSafeText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function backgroundLine(
  line: string,
  width: number,
  background: (text: string) => string,
): string {
  const clipped = truncateToWidth(line, Math.max(1, width), "");
  return background(`${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`);
}

function fitLines(lines: readonly string[], width: number): string[] {
  const safeWidth = Math.max(1, width);
  return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

function alignLine(left: string, right: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= safeWidth) return truncateToWidth(right, safeWidth, "");
  const maxLeft = Math.max(0, safeWidth - rightWidth - 1);
  const clippedLeft = truncateToWidth(left, maxLeft, "");
  return `${clippedLeft}${" ".repeat(Math.max(1, safeWidth - visibleWidth(clippedLeft) - rightWidth))}${right}`;
}

function shortModel(model: string): string {
  const withoutProvider = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
  const slash = withoutProvider.lastIndexOf("/");
  return slash < 0 ? withoutProvider : withoutProvider.slice(slash + 1);
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}
