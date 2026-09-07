/**
 * Shared-menu composition follows Prime Agent configuration-menu.ts at
 * 7787f07415d843b9a800f6a4720e0c739bd608e5 (MIT; Mario Zechner / Prime Intellect).
 * The server configuration wizard is Nausicaa glue; it does not implement MCP
 * transport, OAuth, or credential storage. See THIRD_PARTY_NOTICES.
 */
import { type Component, type Focusable, Input } from "@earendil-works/pi-tui";

import { AuthMenu, type AuthMenuChoice, renderAuthPanel } from "./auth-menu.js";
import type { McpManagement, McpServerSummary } from "./mcp-management.js";
import { nausicaaPalette as palette } from "./tui-components.js";

export interface McpMenuOptions {
  controller: McpManagement;
  getRows: () => number;
  onCancel: () => void;
  onChanged?: () => void;
  requestRender: () => void;
}

type ServerInput = Parameters<McpManagement["add"]>[0];
type ServerDraft = Omit<ServerInput, "access">;

/** Settings only: browsing never invokes add, refresh, or a server process. */
export class McpMenu implements Component, Focusable {
  private menu: AuthMenu | undefined;
  private field: Input | undefined;
  private fieldLabel = "";
  private fieldError = "";
  private servers: readonly McpServerSummary[] = [];
  private draft: ServerDraft = { name: "", transport: "stdio" };
  private _focused = false;
  private disposed = false;
  private generation = 0;

  constructor(private readonly options: McpMenuOptions) {
    void this.load();
  }

  get focused(): boolean { return this._focused; }

  set focused(value: boolean) {
    this._focused = value;
    if (this.menu !== undefined) this.menu.focused = value;
    if (this.field !== undefined) this.field.focused = value;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.field !== undefined) this.field.handleInput(data);
    else this.menu?.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.field === undefined) return this.menu?.render(width) ?? renderAuthPanel([], width);
    const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const padding = Math.min(2, Math.floor((columns - 1) / 2));
    const rows = [
      palette.strong(palette.text("Add MCP server")),
      "",
      palette.text(this.fieldLabel),
      ...this.field.render(columns - padding * 2),
      ...(this.fieldError ? ["", palette.warning(this.fieldError)] : []),
    ];
    return renderAuthPanel(rows, columns);
  }

  invalidate(): void {
    this.menu?.invalidate();
    this.field?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.focused = false;
    this.menu = undefined;
    this.field = undefined;
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }

  private close(): void {
    if (this.disposed) return;
    this.dispose();
    this.options.onCancel();
  }

  private showMenu(
    title: string,
    choices: readonly AuthMenuChoice[],
    select: (value: string) => void,
    options: { subtitle?: string; current?: string; searchable?: boolean; headerLines?: readonly string[]; back?: () => void } = {},
  ): void {
    if (this.disposed) return;
    this.field = undefined;
    this.menu = new AuthMenu({
      title,
      choices,
      getRows: this.options.getRows,
      onSelect: select,
      onCancel: options.back ?? (() => this.close()),
      ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
      ...(options.current === undefined ? {} : { current: options.current }),
      searchable: options.searchable ?? false,
      searchPlaceholder: "Search servers",
      emptyMessage: "No matching servers",
      ...(options.headerLines === undefined ? {} : { headerLines: options.headerLines }),
    });
    this.menu.focused = this.focused;
    this.requestRender();
  }

  private showBusy(message: string): void {
    this.showMenu("MCP Servers", [{ value: "busy", label: message }], () => {});
  }

  private async load(notice?: string, current?: string): Promise<void> {
    const generation = ++this.generation;
    this.showBusy("Loading settings...");
    try {
      const servers = await this.options.controller.list();
      if (this.disposed || generation !== this.generation) return;
      this.servers = [...servers];
      this.showList(notice, current);
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.showList("Could not read MCP settings.", current);
      }
    }
  }

  private showList(notice?: string, current?: string): void {
    const choices: AuthMenuChoice[] = this.servers.map((server) => ({
      value: `server:${server.name}`,
      label: server.name,
      detail: `${server.transport === "http" ? "HTTP" : "stdio"} | ${server.origin} | ${server.toolCount} tools`,
      status: server.status.includes("restart required") || server.enabled ? server.status : "disabled",
      searchText: server.name,
    }));
    choices.push(
      { value: "add", label: "Add server", detail: "stdio or HTTP" },
      { value: "refresh", label: "Refresh status" },
    );
    this.showMenu("MCP Servers", choices, (value) => {
      if (value === "add") {
        this.draft = { name: "", transport: "stdio" };
        this.showName();
      } else if (value === "refresh") {
        void this.perform("Refreshing status...", () => this.options.controller.refresh(), false);
      } else {
        const server = this.servers.find((entry) => `server:${entry.name}` === value);
        if (server !== undefined) this.showServer(server);
      }
    }, { searchable: true, ...(notice === undefined ? {} : { subtitle: notice }), ...(current === undefined ? {} : { current }) });
  }

  private showServer(server: McpServerSummary): void {
    const back = (): void => this.showList(undefined, `server:${server.name}`);
    if (server.origin === "project") {
      this.showMenu(server.name, [{ value: "back", label: "Back", detail: "Project configuration is read-only here." }], back, {
        subtitle: `${server.transport} | ${server.enabled ? server.status : "disabled"} | ${server.toolCount} tools`,
        back,
      });
      return;
    }
    this.showMenu(server.name, [
      { value: "toggle", label: server.enabled ? "Disable server" : "Enable server", status: server.enabled ? "enabled" : "disabled" },
      { value: "remove", label: "Remove server" },
      { value: "back", label: "Back" },
    ], (value) => {
      if (value === "toggle") {
        void this.perform("Saving settings...", () => this.options.controller.setEnabled(server.name, !server.enabled));
      } else if (value === "remove") this.showRemove(server);
      else back();
    }, { subtitle: `${server.transport} | ${server.status} | ${server.toolCount} tools`, back });
  }

  private showRemove(server: McpServerSummary): void {
    const back = (): void => this.showServer(server);
    this.showMenu(`Remove ${server.name}?`, [
      { value: "cancel", label: "Cancel" },
      { value: "remove", label: "Remove server", detail: "Delete this user configuration." },
    ], (value) => {
      if (value === "remove") void this.perform("Removing configuration...", () => this.options.controller.remove(server.name));
      else back();
    }, { current: "cancel", back });
  }

  private showField(
    label: string,
    initial: string,
    submit: (value: string) => string | undefined,
    back: () => void,
  ): void {
    this.menu = undefined;
    const field = new Input();
    field.setValue(initial);
    field.handleInput("\x1b[F");
    field.focused = this.focused;
    field.onSubmit = (value) => {
      const error = submit(value);
      if (this.field === field) this.fieldError = error ?? "";
      this.requestRender();
    };
    field.onEscape = back;
    this.field = field;
    this.fieldLabel = label;
    this.fieldError = "";
    this.requestRender();
  }

  private showName(): void {
    this.showField("Server name", this.draft.name, (value) => {
      const name = value.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) return "Use 1-64 letters, digits, dots, hyphens or underscores.";
      if (this.servers.some((server) => server.name === name)) return "A server with this name already exists.";
      this.draft = { ...this.draft, name };
      this.showTransport();
      return undefined;
    }, () => this.showList());
  }

  private showTransport(): void {
    this.showMenu("Transport", [
      { value: "stdio", label: "stdio", detail: "Local command" },
      { value: "http", label: "HTTP", detail: "Remote endpoint" },
    ], (value) => {
      if (value !== "stdio" && value !== "http") return;
      this.draft = { ...this.draft, transport: value };
      if (value === "stdio") this.showCommand();
      else this.showEndpoint();
    }, { current: this.draft.transport, back: () => this.showName() });
  }

  private showCommand(): void {
    this.showField("Command", this.draft.command ?? "", (value) => {
      const command = value.trim();
      if (!command || command.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(command)) return "Enter a valid executable name or path.";
      this.draft = { ...this.draft, command };
      this.showArguments();
      return undefined;
    }, () => this.showTransport());
  }

  private showArguments(): void {
    this.showField("Arguments (JSON array)", JSON.stringify(this.draft.args ?? []), (value) => {
      if (value.length > 64 * 1024) return "Arguments are too long.";
      let args: unknown;
      try { args = JSON.parse(value.trim() || "[]"); } catch { return "Enter a JSON array of strings."; }
      if (!Array.isArray(args) || args.length > 256 || !args.every((entry): entry is string => typeof entry === "string")) {
        return "Enter a JSON array of at most 256 strings.";
      }
      this.draft = { ...this.draft, args };
      this.showTrust();
      return undefined;
    }, () => this.showCommand());
  }

  private showEndpoint(): void {
    this.showField("HTTP endpoint", this.draft.endpoint ?? "", (value) => {
      const endpoint = value.trim();
      let url: URL;
      try { url = new URL(endpoint); } catch { return "Enter an absolute HTTP or HTTPS URL."; }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
        return "Use HTTP or HTTPS without credentials or fragments.";
      }
      this.draft = { ...this.draft, endpoint };
      this.showTrust();
      return undefined;
    }, () => this.showTransport());
  }

  private showTrust(): void {
    const local = this.draft.transport === "stdio";
    this.showMenu(local ? "Run program as you?" : "Connect HTTP endpoint?", [
      { value: "cancel", label: "Cancel" },
      { value: "read", label: "Save read-only", detail: "Read-only tools" },
      { value: "full", label: "Full capability...", detail: "Allow tools that change state." },
    ], (value) => {
      if (value === "read") this.save("read");
      else if (value === "full") this.showFullConfirmation();
      else this.showList();
    }, {
      subtitle: this.trustTarget(),
      ...(local ? { headerLines: ["No process sandbox"] } : {}),
      current: "cancel",
      back: () => this.draft.transport === "http" ? this.showEndpoint() : this.showArguments(),
    });
  }

  private showFullConfirmation(): void {
    this.showMenu("Allow full capability?", [
      { value: "cancel", label: "Cancel" },
      { value: "full", label: "Save with full capability", detail: "Server tools may write files or run commands." },
    ], (value) => {
      if (value === "full") this.save("full");
      else this.showTrust();
    }, {
      subtitle: this.trustTarget(),
      ...(this.draft.transport === "stdio" ? { headerLines: ["No process sandbox"] } : {}),
      current: "cancel",
      back: () => this.showTrust(),
    });
  }

  private trustTarget(): string {
    if (this.draft.transport === "stdio") return this.draft.command ?? "Local program";
    const url = new URL(this.draft.endpoint!);
    return `${url.origin}${url.pathname}`;
  }

  private save(access: "read" | "full"): void {
    const input: ServerInput = this.draft.transport === "http"
      ? { name: this.draft.name, transport: "http", endpoint: this.draft.endpoint!, access }
      : { name: this.draft.name, transport: "stdio", command: this.draft.command!, args: this.draft.args ?? [], access };
    void this.perform("Saving server...", () => this.options.controller.add(input));
  }

  private async perform(message: string, action: () => Promise<void>, configurationChanged = true): Promise<void> {
    const generation = ++this.generation;
    this.showBusy(message);
    try {
      await action();
      if (this.disposed || generation !== this.generation) return;
      if (configurationChanged) {
        try { this.options.onChanged?.(); } catch { /* The configuration is already saved. */ }
      }
      await this.load(configurationChanged ? "saved; restart required" : undefined);
    } catch {
      if (!this.disposed && generation === this.generation) this.showList("MCP operation failed. Settings were not confirmed.");
    }
  }
}
