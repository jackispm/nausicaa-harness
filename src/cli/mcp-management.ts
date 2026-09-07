import {
  readUserSettings,
  updateUserSettings,
  type UserSettingsOptions,
} from "../config/user-settings.js";
import {
  resolveEdgeSettings,
  type EdgeHostGrantSettings,
  type EdgeSourceSettings,
} from "../config/settings.js";
import type { EdgeStatusProjection } from "./edge-status.js";

export interface McpServerSummary {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  origin: "user" | "project";
  status: string;
  toolCount: number;
}

export interface McpServerInput {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: readonly string[];
  endpoint?: string;
  access: "read" | "full";
}

export interface McpManagement {
  list(): Promise<readonly McpServerSummary[]>;
  add(input: McpServerInput): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  remove(name: string): Promise<void>;
  refresh(): Promise<void>;
}

/** Prime's configured-connections boundary, retaining Nausicaa's explicit host grants. */
export function createMcpManagement(options: {
  settings?: UserSettingsOptions;
  configuredSources?: readonly EdgeSourceSettings[];
  status: () => EdgeStatusProjection;
  refresh: () => Promise<void>;
}): McpManagement {
  const pending = new Set<string>();
  const configured = options.configuredSources ?? [];
  const findUserSource = (sources: readonly EdgeSourceSettings[], name: string): EdgeSourceSettings => {
    const source = sources.find((entry) => entry.sourceId === name && entry.type === "mcp");
    if (source === undefined) throw new Error("This MCP server is not managed in user settings");
    return source;
  };
  return {
    list: async () => {
      const settings = await readUserSettings(options.settings);
      const userSources = settings.edges?.sources ?? [];
      const runtime = options.status();
      const sources = [...userSources, ...configured.filter((source) => !userSources.some((entry) => entry.sourceId === source.sourceId) && !pending.has(source.sourceId))];
      return sources.filter((source) => source.type === "mcp").map((source) => {
        const live = runtime.sources.find((entry) => entry.sourceId === source.sourceId);
        return {
          name: source.sourceId,
          transport: source.endpoint === undefined ? "stdio" as const : "http" as const,
          enabled: source.enabled !== false,
          origin: userSources.includes(source) ? "user" as const : "project" as const,
          status: pending.has(source.sourceId) ? "saved; restart required"
            : settings.edges?.enabled === false ? "disabled globally"
              : live?.health ?? live?.status ?? "not connected",
          toolCount: live?.toolCount ?? 0,
        };
      }).sort((left, right) => left.name.localeCompare(right.name));
    },
    add: async (input) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.name)) throw new Error("Use a server name with letters, numbers, dots, underscores or hyphens (up to 64 characters)");
      if (input.access !== "read" && input.access !== "full") throw new Error("Choose an explicit MCP access grant");
      if (input.transport !== "http" && input.transport !== "stdio") throw new Error("Choose HTTP or stdio");
      if (input.transport === "http") {
        let url: URL;
        try { url = new URL(input.endpoint ?? ""); } catch { throw new Error("Enter an absolute HTTP or HTTPS endpoint"); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use an HTTP(S) endpoint without embedded credentials or a fragment");
      }
      const source: EdgeSourceSettings = {
        sourceId: input.name, type: "mcp", enabled: true,
        ...(input.transport === "http" ? { endpoint: input.endpoint! }
          : { command: input.command ?? "", args: [...(input.args ?? [])] }),
      };
      const grant: EdgeHostGrantSettings = {
        sourceId: input.name,
        effects: input.access === "read" ? ["read", "compute"] : ["read", "compute", "write", "external"],
        scopes: ["workspace", "run", "lane", "host"],
        allowWithoutApproval: true,
      };
      // Validate with the same parser used at startup, before touching the file.
      resolveEdgeSettings({ sources: [source], grants: [grant] }, undefined);
      await updateUserSettings((settings) => {
        const edges = settings.edges ?? {};
        if ([...(edges.sources ?? []), ...configured].some((entry) => entry.sourceId === input.name) && !pending.has(input.name)) throw new Error("An MCP source already uses this name");
        if ((edges.sources ?? []).some((entry) => entry.sourceId === input.name)) throw new Error("An MCP source already uses this name");
        const nextEdges = { ...edges, sources: [...(edges.sources ?? []), source], grants: [...(edges.grants ?? []).filter((entry) => entry.sourceId !== input.name), grant] };
        resolveEdgeSettings(nextEdges, undefined);
        return { ...settings, edges: nextEdges };
      }, options.settings);
      pending.add(input.name);
    },
    setEnabled: async (name, enabled) => {
      await updateUserSettings((settings) => {
        const edges = settings.edges ?? {};
        findUserSource(edges.sources ?? [], name);
        return { ...settings, edges: { ...edges, sources: (edges.sources ?? []).map((source) => source.sourceId === name ? { ...source, enabled } : source) } };
      }, options.settings);
      pending.add(name);
    },
    remove: async (name) => {
      await updateUserSettings((settings) => {
        const edges = settings.edges ?? {};
        findUserSource(edges.sources ?? [], name);
        return { ...settings, edges: { ...edges, sources: (edges.sources ?? []).filter((source) => source.sourceId !== name), grants: (edges.grants ?? []).filter((grant) => grant.sourceId !== name) } };
      }, options.settings);
      pending.add(name);
    },
    refresh: options.refresh,
  };
}
