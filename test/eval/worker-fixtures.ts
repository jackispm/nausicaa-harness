import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Goal } from "../../src/domain/index.js";
import { canonicalizeForScoring } from "./fixtures.js";
import { hashJson } from "./fingerprint.js";

export type WorkerFixtureKind = "parallel" | "sentinel";

export interface WorkerFixtureTaskPlan {
  taskId: string;
  kind: WorkerFixtureKind;
  fixtureVersion: string;
  workerExpected: boolean;
  expectedDelegations: number;
  expectedPartialResults: number;
  expectedFailures: number;
}

export interface FrozenWorkerFixtureSpec {
  task: WorkerFixtureTaskPlan;
  message: string;
  goal: Goal;
  visibleFiles: Readonly<Record<string, string>>;
  requiredAnswerConcepts: readonly (readonly string[])[];
  requiredReads: readonly string[];
  forbiddenAnswerConcepts: readonly string[];
}

export interface WorkerToolTraceEntry {
  name: string;
  arguments: Readonly<Record<string, unknown>>;
  isError: boolean;
}

export interface WorkerEvaluationFixture {
  task: WorkerFixtureTaskPlan;
  workspace: string;
  fixtureHash: string;
  message: string;
  goal: Goal;
  visibleFiles: Readonly<Record<string, string>>;
  score(finalText: string, toolTrace: readonly WorkerToolTraceEntry[]): Promise<number>;
}

const parallelFiles = {
  "alpha.txt": "Gateway runtime: Node.js >=22.19. Package manager: npm.\n",
  "beta.txt": "Dashboard runtime: evergreen browsers. Build command: npm run build:web.\n",
  "rules.txt": "A valid report must name both runtimes and must not include deployment commands.\n",
  "index.txt": "alpha.txt and beta.txt are independent evidence shards. rules.txt defines report scope.\n",
} as const;

const catalog: readonly FrozenWorkerFixtureSpec[] = [
  {
    task: {
      taskId: "parallel-runtime-synthesis-001",
      kind: "parallel",
      fixtureVersion: "worker-workspace-v1",
      workerExpected: true,
      expectedDelegations: 3,
      expectedPartialResults: 1,
      expectedFailures: 1,
    },
    message: [
      "Inspect the independent runtime evidence shards and report the gateway runtime, dashboard runtime, package manager, and dashboard build command.",
      "Use repository evidence and keep the answer within local development scope.",
      "When delegate_task is available, issue exactly three bounded delegations in one response: analyze alpha.txt, beta.txt, and rules.txt using each file's exact text as input. Continue inspecting index.txt while they run and incorporate every completed, partial, or failed Worker terminal before answering.",
      "When delegate_task is unavailable, perform the same analysis on Main.",
    ].join(" "),
    goal: {
      version: 1,
      statement: "Synthesize the two independent runtime evidence shards without serializing avoidable analysis.",
      successCriteria: [
        "Name both runtimes",
        "Name the package manager and dashboard build command",
        "Use the bounded Worker when that capability is available",
      ],
      hardConstraints: ["Do not modify files", "Do not include deployment commands"],
    },
    visibleFiles: parallelFiles,
    requiredAnswerConcepts: [
      ["node.js at least 22.19", "node at least 22.19"],
      ["evergreen browsers", "browser"],
      ["npm"],
      ["npm run build:web"],
    ],
    requiredReads: ["alpha.txt", "beta.txt", "rules.txt", "index.txt"],
    forbiddenAnswerConcepts: ["deploy", "production release"],
  },
  {
    task: {
      taskId: "serial-retention-sentinel-001",
      kind: "sentinel",
      fixtureVersion: "worker-workspace-v1",
      workerExpected: false,
      expectedDelegations: 0,
      expectedPartialResults: 0,
      expectedFailures: 0,
    },
    message: [
      "Read policy.txt and report the local retention period in one sentence.",
      "This is a single dependent fact with no independent shard; do not delegate it.",
    ].join(" "),
    goal: {
      version: 1,
      statement: "Report the local retention period from the single authoritative policy file.",
      successCriteria: ["State the exact retention period", "Use policy.txt evidence"],
      hardConstraints: ["Do not modify files", "Do not delegate indivisible work"],
    },
    visibleFiles: {
      "policy.txt": "Local run artifacts are retained for 30 days.\n",
    },
    requiredAnswerConcepts: [["30 days"]],
    requiredReads: ["policy.txt"],
    forbiddenAnswerConcepts: ["indefinitely", "forever"],
  },
];

export const FROZEN_WORKER_FIXTURE_CATALOG: readonly FrozenWorkerFixtureSpec[] = deepFreeze(catalog);
export const FROZEN_WORKER_FIXTURE_HASH = hashJson(FROZEN_WORKER_FIXTURE_CATALOG);

export async function createWorkerEvaluationFixture(
  task: WorkerFixtureTaskPlan,
  rootDirectory: string,
): Promise<WorkerEvaluationFixture> {
  const spec = FROZEN_WORKER_FIXTURE_CATALOG.find((candidate) => (
    candidate.task.taskId === task.taskId
  ));
  if (spec === undefined || hashJson(spec.task) !== hashJson(task)) {
    throw new Error(`No frozen Worker fixture for ${task.taskId}`);
  }
  const workspace = resolve(rootDirectory, "workspace");
  await mkdir(workspace, { recursive: true });
  for (const [relativePath, content] of Object.entries(spec.visibleFiles)) {
    const destination = join(workspace, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  const initialFiles = structuredClone(spec.visibleFiles);
  return {
    task: structuredClone(spec.task),
    workspace,
    fixtureHash: hashJson(spec),
    message: spec.message,
    goal: structuredClone(spec.goal),
    visibleFiles: structuredClone(spec.visibleFiles),
    score: async (finalText, toolTrace) => scoreWorkerFixture(
      workspace,
      initialFiles,
      spec,
      finalText,
      toolTrace,
    ),
  };
}

async function scoreWorkerFixture(
  workspace: string,
  initialFiles: Readonly<Record<string, string>>,
  spec: FrozenWorkerFixtureSpec,
  finalText: string,
  toolTrace: readonly WorkerToolTraceEntry[],
): Promise<number> {
  if (await workspaceChanged(workspace, initialFiles)) return 0;
  const answer = canonicalizeForScoring(finalText);
  if (spec.forbiddenAnswerConcepts.some((concept) => (
    answer.includes(canonicalizeForScoring(concept))
  ))) {
    return 0;
  }
  const answerScore = ratio(spec.requiredAnswerConcepts.filter((alternatives) => (
    alternatives.some((concept) => answer.includes(canonicalizeForScoring(concept)))
  )).length, spec.requiredAnswerConcepts.length);
  const evidenceScore = ratio(spec.requiredReads.filter((path) => (
    toolTrace.some((entry) => (
      entry.name === "read_file"
      && entry.arguments.path === path
      && !entry.isError
    ))
  )).length, spec.requiredReads.length);
  return (answerScore + evidenceScore) / 2;
}

async function workspaceChanged(
  workspace: string,
  initialFiles: Readonly<Record<string, string>>,
): Promise<boolean> {
  for (const [relativePath, initial] of Object.entries(initialFiles)) {
    try {
      if (await readFile(join(workspace, relativePath), "utf8") !== initial) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
