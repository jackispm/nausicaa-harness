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
  it("advertises closure requirements and preserves a files-search to batched-read trace", async () => {
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
    for (const request of model.requests) assertEvidenceTools(request);

    expect(model.followedTruncation).toBe(true);
    expect(model.readBatchSize).toBe(EVIDENCE_PATHS.length);
    const searches = trace.filter((entry) => entry.name === "grep");
    expect(searches).toHaveLength(2);
    expect(searches[0]?.arguments).toMatchObject({
      path: ".",
      outputMode: "files",
      limit: 3,
    });
    expect(searches[1]?.arguments).toMatchObject({
      path: ".",
      outputMode: "files",
      limit: 3,
    });

    const reads = trace.filter((entry) => entry.name === "read_many");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.isError).toBe(false);
    expect((reads[0]?.arguments.targets as Array<{ path: string }>)
      .map((target) => target.path).sort()).toEqual(EVIDENCE_PATHS);
  });
});

class EvidenceClosureModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  followedTruncation = false;
  readBatchSize = 0;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const pages = searchPages(request);
    if (pages.length === 0) {
      return toolResponse([call("search-page-1", "grep", {
        pattern: "TokenTable|configuredTokens|Token|configured tokens",
        path: ".",
        outputMode: "files",
        ignoreCase: true,
        limit: 3,
      })]);
    }

    const latest = pages.at(-1)!;
    if (latest.truncated) {
      if (latest.nextCursor === undefined) {
        throw new Error("A truncated matching-file search must expose nextCursor");
      }
      this.followedTruncation = true;
      return toolResponse([call(`search-page-${pages.length + 1}`, "grep", {
        pattern: "TokenTable|configuredTokens|Token|configured tokens",
        path: ".",
        outputMode: "files",
        ignoreCase: true,
        limit: 3,
        cursor: latest.nextCursor,
      })]);
    }

    const discovered = [...new Set(pages.flatMap((page) => page.files))]
      .sort();
    if (!hasReadResults(request)) {
      this.readBatchSize = discovered.length;
      return toolResponse([call("read-evidence", "read_many", {
        targets: discovered.map((path) => ({ path })),
      })]);
    }

    return response("Evidence closure complete.", [], "stop");
  }
}

interface SearchPage {
  files: string[];
  truncated: boolean;
  nextCursor?: string;
}

function searchPages(request: ModelRequest): SearchPage[] {
  return request.messages.flatMap((message) => {
    if (message.role !== "tool" || message.toolName !== "grep" || message.isError) return [];
    const parsed = JSON.parse(message.content) as SearchPage;
    return [parsed];
  });
}

function hasReadResults(request: ModelRequest): boolean {
  return request.messages.some((message) => (
    message.role === "tool" && message.toolName === "read_many" && !message.isError
  ));
}

function assertEvidenceTools(request: ModelRequest): void {
  const grep = request.tools.find((tool) => tool.name === "grep");
  expect(grep, "missing repository evidence contract: grep tool").toBeDefined();
  const outputMode = grep?.parameters.properties?.outputMode;
  expect(outputMode, "missing repository evidence contract: grep output mode").toMatchObject({
    enum: expect.arrayContaining(["files"]),
  });
  const readMany = request.tools.find((tool) => tool.name === "read_many");
  expect(readMany, "missing repository evidence contract: read_many tool").toBeDefined();
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
