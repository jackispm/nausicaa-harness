import { sha256 } from "../../../src/ledger/hash.js";
import { hashJson } from "../fingerprint.js";
import {
  BETA_CAPABILITY_SCORER_VERSION,
  type BetaAttribution,
  type BetaCaseId,
  type BetaCaseManifest,
} from "./types.js";

const deepSeek: BetaAttribution = {
  project: "DeepSeek Harness",
  sourcePath: "/Users/gongdongjie/Downloads/deepseek-harness/examples/headless-agent/tests/coding-task.e2e.ts",
  commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  license: "MIT",
  adopted: ["temporary workspace", "real bug-fix task", "external test execution", "immutable test file"],
  rejected: ["Cordis", "plugin system", "runtime implementation"],
};
const deepSeekResume: BetaAttribution = {
  project: "DeepSeek Harness",
  sourcePath: "/Users/gongdongjie/Downloads/deepseek-harness/examples/headless-agent/tests/resume.e2e.ts",
  commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  license: "MIT",
  adopted: ["world-state verification", "separate resume phase design"],
  rejected: ["Cordis", "live recovery runtime"],
};
const deepSeekFullLoop: BetaAttribution = {
  project: "DeepSeek Harness",
  sourcePath: "/Users/gongdongjie/Downloads/deepseek-harness/examples/headless-agent/tests/full-loop.e2e.ts",
  commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  license: "MIT",
  adopted: ["real model", "real bash round trip", "tool-result and final-answer verification"],
  rejected: ["Cordis", "DeepSeek provider binding", "runtime implementation"],
};
const deepSeekRealModel: BetaAttribution = {
  project: "DeepSeek Harness",
  sourcePath: "/Users/gongdongjie/Downloads/deepseek-harness/examples/headless-agent/tests/real-model.e2e.ts",
  commit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  license: "MIT",
  adopted: ["temporary workspace", "exact file rewrite", "post-agent world verification"],
  rejected: ["Cordis", "loader smoke wrapper", "DeepSeek provider binding"],
};
const piSmoke: BetaAttribution = {
  project: "Pi",
  sourcePath: "/Users/gongdongjie/Downloads/pi/packages/evals/src/smoke.eval.ts",
  commit: "1defa151e0c1dac87d38a2d0ac09d67f817b30f9",
  license: "MIT",
  adopted: ["no-tool end-to-end prompt", "exact final answer and usage observation"],
  rejected: ["Pi session/runtime", "vitest-evals reporter"],
};
const piExtension: BetaAttribution = {
  project: "Pi",
  sourcePath: "/Users/gongdongjie/Downloads/pi/packages/evals/src/extensions.eval.ts",
  commit: "1defa151e0c1dac87d38a2d0ac09d67f817b30f9",
  license: "MIT",
  adopted: ["extension authoring task", "reload/use phases", "external world verification"],
  rejected: ["Pi TypeScript extension loader", "system-prompt A/B harness", "vitest-evals reporter"],
};
const piToolBehavior: BetaAttribution = {
  project: "Pi",
  sourcePath: "/Users/gongdongjie/Downloads/pi/packages/agent/test/harness/tools.test.ts",
  commit: "1defa151e0c1dac87d38a2d0ac09d67f817b30f9",
  license: "MIT",
  adopted: ["bounded read continuation", "multiple independent tool calls", "disjoint edit semantics", "large-output handling"],
  rejected: ["Pi AgentHarness test harness", "faux provider", "legacy tool result format"],
};
const piFindBehavior: BetaAttribution = {
  project: "Pi",
  sourcePath: "/Users/gongdongjie/Downloads/pi/packages/coding-agent/test/suite/regressions/3302-find-path-glob.test.ts",
  commit: "1defa151e0c1dac87d38a2d0ac09d67f817b30f9",
  license: "MIT",
  adopted: ["path-aware glob discovery", "observable workspace result"],
  rejected: ["Pi fd implementation", "mock-only regression fixture"],
};
const pi: BetaAttribution = {
  project: "Pi",
  sourcePath: "/Users/gongdongjie/Downloads/pi/packages/evals/README.md",
  commit: "1defa151e0c1dac87d38a2d0ac09d67f817b30f9",
  license: "MIT",
  adopted: ["same-task comparisons", "repeatable tool traces", "token, latency, and cost telemetry"],
  rejected: ["Pi session/runtime", "extension framework"],
};
const prime: BetaAttribution = {
  project: "Prime Agent",
  sourcePath: "/Users/gongdongjie/Downloads/primeagent/packages/coding-agent/src/modes/daemon",
  commit: "7787f07415d843b9a800f6a4720e0c739bd608e5",
  license: "MIT",
  adopted: ["observable session and artifact metrics"],
  rejected: ["performance benchmark as capability score", "daemon runtime"],
};
const codex: BetaAttribution = {
  project: "Codex",
  sourcePath: "/Users/gongdongjie/Downloads/codex/codex-rs/protocol/src/permission_profile_intersection_tests.rs",
  commit: "31d338a1ea89cd65a48d8ac07f50bb3917009806",
  license: "Apache-2.0",
  adopted: ["fail-closed checks", "isolated reproducible tests"],
  rejected: ["Codex runtime", "performance or help-text tasks"],
};

const BUGGY_ADD = "export function add(a, b) {\n  return a - b;\n}\n";
const ADD_TEST = "import assert from \"node:assert/strict\";\nimport { add } from \"./add.js\";\n\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\n";
const README = "Install with npm install. Requires Node >=22.19. Run checks with npm test.\n";
const scorerContract = {
  version: BETA_CAPABILITY_SCORER_VERSION,
  rules: [
    "grader runs the failing fixture before the agent",
    "grader reruns the test outside the agent",
    "forbidden test bytes and workspace boundary are immutable",
    "at least one successful read and one successful mutation are required",
    "resume completion accepts one optional terminal newline after the two required lines",
    "bash roundtrip requires successful tool output and a grounded final answer",
    "file rewrite verifies exact world state and a post-mutation read",
    "Pi-derived tool cases require structured tool evidence and final world-state verification",
    "delete action requires a successful path_delete call and absent target, not a textual promise",
  ],
} as const;

export const BETA_CAPABILITY_SCORER_HASH = hashJson(scorerContract);
export const BETA_CAPABILITY_SCORER_CONTRACT = Object.freeze(scorerContract);

interface CaseDefinition {
  readonly manifest: BetaCaseManifest;
  readonly files: Readonly<Record<string, string>>;
  readonly goal: { version: 1; statement: string; successCriteria: string[]; hardConstraints: string[] };
  readonly message: string;
}

function file(path: string, role: "source" | "test" | "evidence", content: string): BetaCaseManifest["fixtureFiles"][number] {
  return { path, role, initialHash: sha256(content) };
}

function manifest(
  id: BetaCaseId,
  tier: BetaCaseManifest["tier"],
  enabledTonight: boolean,
  capabilityScore: boolean,
  task: string,
  fixtureFiles: BetaCaseManifest["fixtureFiles"],
  allowedModifyPaths: string[],
  attribution: BetaAttribution[],
  limits: BetaCaseManifest["limits"],
  allowedCapabilities: string[] = ["read_file", "write_file", "edit"],
): BetaCaseManifest {
  return {
    id,
    version: 1,
    tier,
    enabledTonight,
    capabilityScore,
    task,
    allowedCapabilities,
    fixtureFiles,
    allowedModifyPaths,
    graderVersion: BETA_CAPABILITY_SCORER_VERSION,
    graderHash: BETA_CAPABILITY_SCORER_HASH,
    attribution,
    limits,
  };
}

const definitions: readonly CaseDefinition[] = [
  {
    manifest: manifest(
      "compatibility",
      "compatibility",
      true,
      false,
      "Read README.md and report its install command, Node requirement, and test command.",
      [file("README.md", "evidence", README)],
      [],
      [deepSeek, pi],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["read_file", "read_many", "list_files", "grep", "find", "file_info"],
    ),
    files: { "README.md": README },
    message: "Read README.md with the read_file tool, then report the install command, Node requirement, and test command in one short line.",
    goal: {
      version: 1 as const,
      statement: "Report the fixture setup commands from workspace evidence.",
      successCriteria: ["Use read_file evidence before answering"],
      hardConstraints: ["Do not write files"],
    },
  },
  {
    manifest: manifest(
      "bugfix",
      "P0",
      true,
      true,
      "Fix add.js so node add.test.js passes without modifying the test.",
      [file("add.js", "source", BUGGY_ADD), file("add.test.js", "test", ADD_TEST)],
      ["add.js"],
      [deepSeek, pi, codex],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
    ),
    files: { "add.js": BUGGY_ADD, "add.test.js": ADD_TEST },
    message: "The current directory contains add.js and add.test.js. Read the files, fix add.js so node add.test.js passes, and report the result. Do not modify add.test.js or create any other files.",
    goal: {
      version: 1,
      statement: "Repair add.js while preserving the test bytes and workspace boundary.",
      successCriteria: ["node add.test.js passes", "add.test.js remains byte-identical", "use read and mutation tools"],
      hardConstraints: ["Do not modify add.test.js", "Do not create files outside add.js"],
    },
  },
  {
    manifest: manifest(
      "resume",
      "P1",
      true,
      true,
      "Persist a non-sensitive work fact, resume the same session, and complete a small file change.",
      [file("resume.txt", "evidence", "pending\n")],
      ["resume.txt"],
      [deepSeekResume, prime],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
    ),
    files: { "resume.txt": "pending\n" },
    message: "Record the bounded work fact 'resume-ready' in resume.txt and confirm it.",
    goal: {
      version: 1,
      statement: "Exercise durable session continuity before a small file modification.",
      successCriteria: ["Resume the same run", "write resume-ready"],
      hardConstraints: ["Do not write outside resume.txt"],
    },
  },
  {
    manifest: manifest(
      "incident-triage",
      "P1",
      true,
      true,
      "Diagnose the checkout incident from independent evidence without modifying files.",
      [
        file("logs/gateway.log", "evidence", "2026-08-27T09:14:02Z checkout request accepted\n2026-08-27T09:14:05Z payment upstream timed out\n"),
        file("logs/payment.log", "evidence", "2026-08-27T09:14:03Z ERROR missing PAYMENT_REGION; refusing authorization\n"),
        file("config/payment.example", "evidence", "PAYMENT_REGION=eu-west\n"),
        file("runbooks/checkout.md", "evidence", "For a missing PAYMENT_REGION, restore the validated regional value and restart only the payment service. Do not retry captured charges manually.\n"),
      ],
      [],
      [prime, pi],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["read_file", "read_many", "list_files", "grep", "find", "file_info"],
    ),
    files: {
      "logs/gateway.log": "2026-08-27T09:14:02Z checkout request accepted\n2026-08-27T09:14:05Z payment upstream timed out\n",
      "logs/payment.log": "2026-08-27T09:14:03Z ERROR missing PAYMENT_REGION; refusing authorization\n",
      "config/payment.example": "PAYMENT_REGION=eu-west\n",
      "runbooks/checkout.md": "For a missing PAYMENT_REGION, restore the validated regional value and restart only the payment service. Do not retry captured charges manually.\n",
    },
    message: "Triage the checkout incident from the available evidence. Identify the first failing service and timestamp, the downstream symptom, the likely configuration cause, and the safest immediate action.",
    goal: {
      version: 1,
      statement: "Synthesize independent incident evidence into one grounded triage note.",
      successCriteria: ["Identify cause and effect", "Recommend only the approved immediate action"],
      hardConstraints: ["Do not modify files", "Use only repository evidence"],
    },
  },
  {
    manifest: manifest(
      "bash-roundtrip",
      "P0",
      true,
      true,
      "Run echo e2e-ok with the bash tool and report its exact output.",
      [],
      [],
      [deepSeekFullLoop],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["bash"],
    ),
    files: {},
    message: "Run `echo e2e-ok` with the bash tool and tell me its exact output.",
    goal: {
      version: 1,
      statement: "Complete one real workspace-confined Bash round trip.",
      successCriteria: ["Use the bash tool", "Report the observed exact output"],
      hardConstraints: ["Do not write files", "Do not run any command other than echo e2e-ok"],
    },
  },
  {
    manifest: manifest(
      "file-rewrite",
      "P0",
      true,
      true,
      "Read task.txt, replace its complete contents, read it again, and report briefly.",
      [file("task.txt", "source", "value=before\n")],
      ["task.txt"],
      [deepSeekRealModel],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
    ),
    files: { "task.txt": "value=before\n" },
    message: "Read task.txt, replace its complete contents with exactly \"value=after\" followed by a newline, read it again, and report briefly.",
    goal: {
      version: 1,
      statement: "Perform and verify the exact task.txt rewrite.",
      successCriteria: ["task.txt contains exactly value=after followed by a newline", "Read the file after mutation"],
      hardConstraints: ["Do not change or create any other file"],
    },
  },
  {
    manifest: manifest(
      "pi-smoke",
      "compatibility",
      true,
      false,
      "Answer a no-tool factual prompt end to end.",
      [],
      [],
      [piSmoke],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      [],
    ),
    files: {},
    message: "What's the capital of France? Respond with only the city name.",
    goal: {
      version: 1,
      statement: "Answer the factual prompt without using tools.",
      successCriteria: ["Reply with exactly Paris"],
      hardConstraints: ["Do not call tools", "Reply with only the city name"],
    },
  },
  {
    manifest: manifest(
      "pi-extension",
      "P1",
      true,
      true,
      "Author a small workspace extension, execute it, and verify its greeting.",
      [],
      [".pi/extensions/hello.js"],
      [piExtension],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["write_file", "bash"],
    ),
    files: {},
    message: "Create .pi/extensions/hello.js with a hello(name) function that returns exactly `Hello, ${name}!`. Use write_file for the extension source, then run `node .pi/extensions/hello.js Bob` with bash after making the file executable as a CLI. Report exactly the greeting and do not create any other files.",
    goal: {
      version: 1,
      statement: "Author and exercise a workspace extension with a stable greeting contract.",
      successCriteria: ["hello.js exists", "The external command prints Hello, Bob!", "Final answer is the greeting"],
      hardConstraints: ["Use write_file for .pi/extensions/hello.js", "Do not create any other files"],
    },
  },
  {
    manifest: manifest(
      "pi-read-window",
      "P1",
      true,
      true,
      "Read a large file through bounded windows and continue from the returned offset.",
      [file("large.txt", "evidence", Array.from({ length: 2050 }, (_, index) => `Line ${index + 1}`).join("\n"))],
      [],
      [piToolBehavior],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["read_file"],
    ),
    files: { "large.txt": Array.from({ length: 2050 }, (_, index) => `Line ${index + 1}`).join("\n") },
    message: "Read large.txt and report exactly `Line 1 | Line 2050`. The file is larger than one read window: start at the beginning, follow the read_file nextOffset response, and do not jump directly to offset 2050.",
    goal: {
      version: 1,
      statement: "Exercise bounded file reads and continuation without losing the requested evidence.",
      successCriteria: ["Read large.txt", "Use a continuation offset returned by read_file", "Report Line 1 and Line 2050"],
      hardConstraints: ["Do not modify files", "Do not use any tool other than read_file", "Do not jump directly to offset 2050"],
    },
  },
  {
    manifest: manifest(
      "pi-parallel-tools",
      "P1",
      true,
      true,
      "Read two independent files and ground the final answer in both tool results.",
      [file("alpha.txt", "evidence", "alpha-value\n"), file("beta.txt", "evidence", "beta-value\n")],
      [],
      [piToolBehavior],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["read_file"],
    ),
    files: { "alpha.txt": "alpha-value\n", "beta.txt": "beta-value\n" },
    message: "Read alpha.txt and beta.txt with independent read_file calls, then respond with exactly `alpha-value | beta-value` and nothing else.",
    goal: {
      version: 1,
      statement: "Complete independent tool calls and combine their observed values.",
      successCriteria: ["Read alpha.txt", "Read beta.txt", "Return both exact values"],
      hardConstraints: ["Do not modify files", "Use read_file for both files", "Return only the requested line"],
    },
  },
  {
    manifest: manifest(
      "pi-edit-disjoint",
      "P0",
      true,
      true,
      "Apply two disjoint edits in one call and verify the resulting file.",
      [file("edit.txt", "source", "alpha\nbeta\ngamma\ndelta\n")],
      ["edit.txt"],
      [piToolBehavior],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["read_file", "edit"],
    ),
    files: { "edit.txt": "alpha\nbeta\ngamma\ndelta\n" },
    message: "Read edit.txt, then use one edit call with two disjoint replacements: alpha -> ALPHA and gamma -> GAMMA. Read it again and reply exactly `ALPHA | GAMMA`.",
    goal: {
      version: 1,
      statement: "Use one exact multi-edit operation and verify both changes.",
      successCriteria: ["Read before editing", "One edit call contains both replacements", "Read after editing", "Final text is exact"],
      hardConstraints: ["Do not modify or create any other file"],
    },
  },
  {
    manifest: manifest(
      "pi-find-scope",
      "P1",
      true,
      true,
      "Use a path-aware glob while respecting nested ignore scope.",
      [
        file("a/.gitignore", "evidence", "ignored.txt\n"),
        file("a/ignored.txt", "evidence", "a-secret\n"),
        file("a/kept.txt", "evidence", "a-kept\n"),
        file("b/ignored.txt", "evidence", "b-visible\n"),
        file("b/kept.txt", "evidence", "b-kept\n"),
        file("root.txt", "evidence", "root\n"),
      ],
      [],
      [piFindBehavior],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["find"],
    ),
    files: {
      "a/.gitignore": "ignored.txt\n",
      "a/ignored.txt": "a-secret\n",
      "a/kept.txt": "a-kept\n",
      "b/ignored.txt": "b-visible\n",
      "b/kept.txt": "b-kept\n",
      "root.txt": "root\n",
    },
    message: "Use find with the pattern `**/*.txt` to discover all visible text files. Report exactly these paths, one per line and sorted: a/kept.txt, b/ignored.txt, b/kept.txt, root.txt. Do not read or modify files.",
    goal: {
      version: 1,
      statement: "Discover visible files using a recursive glob and scoped ignore rules.",
      successCriteria: ["Use find with **/*.txt", "Exclude a/ignored.txt", "Include b/ignored.txt", "Return the four visible paths"],
      hardConstraints: ["Do not modify files", "Do not use shell", "Do not read file contents"],
    },
  },
  {
    manifest: manifest(
      "pi-bash-tail",
      "P1",
      true,
      true,
      "Run a high-volume command and report its bounded tail without claiming unavailable output.",
      [],
      [],
      [piToolBehavior],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["bash"],
    ),
    files: {},
    message: "Run this exact Bash command with the bash tool: `i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i + 1)); done`. Report the final observed line `line-3000` and say whether the structured result reports truncation.",
    goal: {
      version: 1,
      statement: "Handle bounded large command output and ground the answer in the returned tail and metadata.",
      successCriteria: ["Run the exact command", "Observe line-3000", "Report the truncation state"],
      hardConstraints: ["Do not write files", "Use bash exactly once"],
    },
  },
  {
    manifest: manifest(
      "pi-delete-action",
      "P0",
      true,
      true,
      "Perform a requested deletion through the structured path tool and verify the world state.",
      [file("temp-threejs-landing.html", "source", "temporary fixture\n")],
      ["temp-threejs-landing.html"],
      [piToolBehavior],
      { maxMainSteps: 100, requestBudgetHint: 100, maxOutputTokens: 10_200, timeoutMs: 600_000 },
      ["path_delete", "list_files"],
    ),
    files: { "temp-threejs-landing.html": "temporary fixture\n" },
    message: "Delete temp-threejs-landing.html using path_delete, then verify it is absent with list_files. Do not merely say you deleted it: perform the structured tool call. Reply exactly `deleted`.",
    goal: {
      version: 1,
      statement: "Turn an explicit deletion request into a real tool action and verify absence.",
      successCriteria: ["Call path_delete successfully", "Target is absent after the call", "Reply exactly deleted"],
      hardConstraints: ["Do not delete any other path", "Do not use bash", "Do not claim completion without the tool call"],
    },
  },
  ...(["edge-extension", "multi-agent", "fukai-compaction", "permission-boundary"] as const).map((id) => ({
    manifest: manifest(
      id,
      "P2",
      false,
      true,
      `Catalog placeholder for ${id}; not scheduled for tonight.`,
      [],
      [],
      [pi, codex],
      { maxMainSteps: 1, requestBudgetHint: 0, maxOutputTokens: 128, timeoutMs: 30_000 },
    ),
    files: {},
    message: "This catalog entry is not scheduled for tonight.",
    goal: {
      version: 1 as const,
      statement: `Catalog placeholder for ${id}.`,
      successCriteria: ["Remain unexecuted"],
      hardConstraints: ["Do not run"],
    },
  })),
];

export const BETA_CAPABILITY_CATALOG = deepFreeze(definitions.map(({ manifest: value }) => value));
export const BETA_CAPABILITY_MANIFEST_HASH = hashJson(BETA_CAPABILITY_CATALOG);
export const BETA_CAPABILITY_MANIFEST = deepFreeze({
  schemaVersion: 1 as const,
  suite: "beta-capability-minieval" as const,
  cases: BETA_CAPABILITY_CATALOG,
  manifestHash: BETA_CAPABILITY_MANIFEST_HASH,
  scorerHash: BETA_CAPABILITY_SCORER_HASH,
});

export function betaCaseOrder(): readonly BetaCaseId[] {
  return BETA_CAPABILITY_CATALOG.map((value) => value.id);
}

export function getBetaCaseDefinition(id: BetaCaseId): CaseDefinition {
  const value = definitions.find((candidate) => candidate.manifest.id === id);
  if (value === undefined) throw new Error(`Unknown beta capability case: ${id}`);
  return value;
}

export function getBetaCaseManifest(id: BetaCaseId): BetaCaseManifest {
  return getBetaCaseDefinition(id).manifest;
}

export function verifyBetaCaseManifest(manifestValue: BetaCaseManifest): void {
  const canonical = getBetaCaseManifest(manifestValue.id);
  if (hashJson(manifestValue) !== hashJson(canonical)) {
    throw new Error(`Beta capability manifest was modified: ${manifestValue.id}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
