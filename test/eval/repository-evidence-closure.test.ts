import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "../../src/domain/index.js";
import { executeRun } from "../../src/runtime/index.js";
import { createWorkspaceTools } from "../../src/tools/index.js";
import { traceTools, type ToolTraceEntry } from "./fixtures.js";

const EVIDENCE_FILES = Object.freeze({
  "01-entry.ts": "import { TokenTable } from './02-definition.js';\nexport const page = TokenTable;\n",
  "02-definition.ts": "export function TokenTable() { return 'tokens'; }\n",
  "03-call-site.ts": "import { TokenTable } from './02-definition.js';\nTokenTable();\n",
  "04-config.ts": "export const configuredTokens = ['FIRMA'];\n",
  "05-types.ts": "export interface Token { ticker: string; }\n",
  "06-tests.ts": "it('admits configured tokens', () => expect(true).toBe(true));\n",
});
const EVIDENCE_PATHS = Object.keys(EVIDENCE_FILES).sort();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository evidence-closure contract", () => {
  it("advertises closure requirements and preserves a paginated, batched evidence trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "nausicaa-evidence-closure-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await Promise.all(Object.entries(EVIDENCE_FILES).map(([path, content]) => (
      writeFile(join(workspace, path), content, "utf8")
    )));

    const trace: ToolTraceEntry[] = [];
    const model = new EvidenceClosureModel();
    const result = await executeRun({
      workspace,
      dataDir: join(root, "state"),
      model: "scripted",
      message: "Explain how the token table admits configured tokens.",
      policy: {
        maxMainStepsPerActivation: 4,
        maxModelTokens: 20_000,
        tetoEnabled: false,
      },
    }, {
      mainModel: model,
      tools: traceTools(createWorkspaceTools(), trace),
      createRunId: () => "repository-evidence-closure",
    });

    expect(result).toMatchObject({
      completed: true,
      finalText: "Evidence closure complete.",
      steps: 4,
    });
    expect(model.requests).toHaveLength(4);
    for (const request of model.requests) assertEvidencePrompt(request.systemPrompt);

    expect(model.followedTruncation).toBe(true);
    expect(model.readBatchSize).toBe(EVIDENCE_PATHS.length);
    const listings = trace.filter((entry) => entry.name === "list_files");
    expect(listings).toHaveLength(2);
    expect(listings[0]?.arguments).toMatchObject({ path: ".", maxEntries: 3 });
    expect(listings[1]?.arguments).toMatchObject({ path: ".", offset: 3, maxEntries: 3 });

    const reads = trace.filter((entry) => entry.name === "read_file");
    expect(reads).toHaveLength(EVIDENCE_PATHS.length);
    expect(reads.every((entry) => !entry.isError)).toBe(true);
    expect(reads.map((entry) => entry.arguments.path).sort()).toEqual(EVIDENCE_PATHS);
  });
});

class EvidenceClosureModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  followedTruncation = false;
  readBatchSize = 0;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const pages = listPages(request);
    if (pages.length === 0) {
      return toolResponse([call("list-page-1", "list_files", {
        path: ".",
        maxEntries: 3,
      })]);
    }

    const latest = pages.at(-1)!;
    if (latest.truncated) {
      if (latest.nextOffset === undefined) {
        throw new Error("A truncated directory listing must expose nextOffset");
      }
      this.followedTruncation = true;
      return toolResponse([call(`list-page-${pages.length + 1}`, "list_files", {
        path: ".",
        offset: latest.nextOffset,
        maxEntries: 3,
      })]);
    }

    const discovered = [...new Set(pages.flatMap((page) => page.entries.map((entry) => entry.path)))]
      .sort();
    if (!hasReadResults(request)) {
      this.readBatchSize = discovered.length;
      return toolResponse(discovered.map((path, index) => (
        call(`read-evidence-${index + 1}`, "read_file", { path })
      )));
    }

    return response("Evidence closure complete.", [], "stop");
  }
}

interface ListPage {
  entries: Array<{ path: string }>;
  truncated: boolean;
  nextOffset?: number;
}

function listPages(request: ModelRequest): ListPage[] {
  return request.messages.flatMap((message) => {
    if (message.role !== "tool" || message.toolName !== "list_files" || message.isError) return [];
    const parsed = JSON.parse(message.content) as ListPage;
    return [parsed];
  });
}

function hasReadResults(request: ModelRequest): boolean {
  return request.messages.some((message) => (
    message.role === "tool" && message.toolName === "read_file" && !message.isError
  ));
}

function assertEvidencePrompt(prompt: string): void {
  const normalized = prompt.toLowerCase();
  for (const concept of [
    "entry point",
    "definition",
    "call site",
    "configuration",
    "types",
    "tests",
    "pagination",
    "truncation",
    "before concluding",
  ]) {
    expect(normalized, `missing repository evidence contract: ${concept}`).toContain(concept);
  }
}

function call(id: string, name: string, arguments_: Record<string, unknown>): ToolCall {
  return { id, name, arguments: arguments_ };
}

function toolResponse(toolCalls: ToolCall[]): ModelResponse {
  return response("", toolCalls, "toolUse");
}

function response(content: string, toolCalls: ToolCall[], stopReason: string): ModelResponse {
  return {
    content,
    toolCalls,
    stopReason,
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
  };
}
