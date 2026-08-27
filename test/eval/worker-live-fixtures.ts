import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Goal } from "../../src/domain/index.js";
import { hashJson } from "./fingerprint.js";

export type WorkerLiveFixtureKind = "decomposable" | "sentinel";

export interface WorkerLiveTaskPlan {
  taskId: string;
  familyId: string;
  kind: WorkerLiveFixtureKind;
  fixtureVersion: "worker-live-natural-v2";
  oracle: "hidden";
  expectedWorkerUse: boolean;
}

export interface WorkerLiveToolTraceEntry {
  laneId: string;
  name: string;
  arguments: Readonly<Record<string, unknown>>;
  isError: boolean;
}

interface HiddenOracle {
  requiredConcepts: readonly (readonly string[])[];
  requiredReads: readonly string[];
  forbiddenConcepts: readonly string[];
}

export interface FrozenWorkerLiveFixtureSpec {
  task: WorkerLiveTaskPlan;
  message: string;
  goal: Goal;
  visibleFiles: Readonly<Record<string, string>>;
  hiddenOracle: HiddenOracle;
}

export interface WorkerLiveFixture {
  task: WorkerLiveTaskPlan;
  workspace: string;
  message: string;
  goal: Goal;
  fixtureHash: string;
  score(
    finalText: string,
    toolTrace: readonly WorkerLiveToolTraceEntry[],
  ): Promise<number>;
}

/** The runner exposes visibleFiles, message, and goal; hiddenOracle stays scorer-only. */
const catalog: readonly FrozenWorkerLiveFixtureSpec[] = [
  {
    task: task("runtime-readiness", "runtime-readiness", "decomposable", true),
    message: "Review this repository's API and dashboard runtime requirements. Give the required Node.js version, supported browser target, package manager, dashboard build command, and the one release restriction that applies to both components.",
    goal: goal(
      "Produce a concise local runtime-readiness summary from the repository evidence.",
      ["Cover both components", "State the shared restriction"],
    ),
    visibleFiles: {
      "services/api/runtime.md": "The API requires Node.js 22.19 or newer and uses npm.\n",
      "services/dashboard/runtime.md": "The dashboard supports evergreen browsers. Build it with npm run build:web.\n",
      "ops/release-policy.md": "Runtime-readiness reports are local-only and must not include production deployment commands.\n",
      "README.md": "Runtime requirements live under services/. Release scope lives under ops/.\n",
    },
    hiddenOracle: {
      requiredConcepts: [
        ["node.js 22.19", "node 22.19"],
        ["evergreen browsers", "evergreen browser"],
        ["npm"],
        ["npm run build:web"],
        ["local-only", "local only"],
      ],
      requiredReads: [
        "services/api/runtime.md",
        "services/dashboard/runtime.md",
        "ops/release-policy.md",
      ],
      forbiddenConcepts: ["kubectl", "production deploy"],
    },
  },
  {
    task: task("incident-triage", "incident-triage", "decomposable", true),
    message: "Triage the checkout incident from the available evidence. Identify the first failing service and timestamp, the downstream symptom, the likely configuration cause, and the safest immediate action.",
    goal: goal(
      "Synthesize the independent incident evidence into one grounded triage note.",
      ["Identify cause and effect", "Recommend only the approved immediate action"],
    ),
    visibleFiles: {
      "logs/gateway.log": "2026-08-27T09:14:02Z checkout request accepted\n2026-08-27T09:14:05Z payment upstream timed out\n",
      "logs/payment.log": "2026-08-27T09:14:03Z ERROR missing PAYMENT_REGION; refusing authorization\n",
      "config/payment.example": "PAYMENT_REGION=eu-west\n",
      "runbooks/checkout.md": "For a missing PAYMENT_REGION, restore the validated regional value and restart only the payment service. Do not retry captured charges manually.\n",
    },
    hiddenOracle: {
      requiredConcepts: [
        ["payment", "payment service"],
        ["09:14:03", "2026-08-27t09:14:03z"],
        ["gateway timeout", "upstream timed out", "payment upstream timed out"],
        ["payment_region", "payment region"],
        ["restart only the payment service", "restart the payment service only"],
      ],
      requiredReads: [
        "logs/gateway.log",
        "logs/payment.log",
        "config/payment.example",
        "runbooks/checkout.md",
      ],
      forbiddenConcepts: ["retry captured charges", "restart all services"],
    },
  },
  {
    task: task("migration-review", "migration-review", "decomposable", true),
    message: "Assess whether the accounts migration is ready. Report the schema change, application compatibility requirement, rollback prerequisite, and final ready/not-ready decision with the blocking evidence.",
    goal: goal(
      "Make a grounded migration-readiness decision from schema, application, and operations evidence.",
      ["Cover every readiness dimension", "Name the blocker precisely"],
    ),
    visibleFiles: {
      "db/042_accounts.sql": "ALTER TABLE accounts ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';\n",
      "app/account-reader.md": "Release 3.8 accepts the locale column. Release 3.7 rejects unknown account fields.\n",
      "ops/rollback.md": "Rollback requires backup marker accounts-pre-042 before applying migration 042.\n",
      "ops/status.md": "Staging runs release 3.8. Backup marker accounts-pre-042 is absent.\n",
    },
    hiddenOracle: {
      requiredConcepts: [
        ["locale", "locale column"],
        ["release 3.8", "3.8"],
        ["accounts-pre-042"],
        ["not ready", "blocked"],
        ["backup marker", "marker is absent", "missing backup"],
      ],
      requiredReads: [
        "db/042_accounts.sql",
        "app/account-reader.md",
        "ops/rollback.md",
        "ops/status.md",
      ],
      forbiddenConcepts: ["ready to apply", "no blocker"],
    },
  },
  {
    task: task("retention-fact", "retention", "sentinel", false),
    message: "What is the retention period for local run artifacts? Answer in one sentence and cite the authoritative repository file.",
    goal: goal(
      "Report the single authoritative local artifact retention period.",
      ["State the exact period", "Cite its source"],
    ),
    visibleFiles: {
      "policy/retention.md": "Local run artifacts are retained for 30 days.\n",
    },
    hiddenOracle: {
      requiredConcepts: [["30 days"], ["policy/retention.md"]],
      requiredReads: ["policy/retention.md"],
      forbiddenConcepts: ["indefinitely", "forever"],
    },
  },
];

export const WORKER_LIVE_SCORER_CONTRACT = deepFreeze({
  version: "worker-live-hidden-scorer-v2",
  formula: "0.8 * required-answer-concepts + 0.2 * required-read-evidence; forbidden concepts use token boundaries and negation-aware matching; evidence paths are workspace-normalized",
  mutationScore: 0,
  forbiddenConceptScore: 0,
} as const);

export const WORKER_LIVE_FIXTURE_CATALOG = deepFreeze(catalog);
export const WORKER_LIVE_FIXTURE_HASH = hashJson(WORKER_LIVE_FIXTURE_CATALOG);
export const WORKER_LIVE_SCORER_HASH = hashJson(WORKER_LIVE_SCORER_CONTRACT);

export async function createWorkerLiveFixture(
  plan: WorkerLiveTaskPlan,
  rootDirectory: string,
): Promise<WorkerLiveFixture> {
  const spec = WORKER_LIVE_FIXTURE_CATALOG.find((candidate) => (
    candidate.task.taskId === plan.taskId
  ));
  if (spec === undefined || hashJson(spec.task) !== hashJson(plan)) {
    throw new Error(`No frozen Worker live fixture for ${plan.taskId}`);
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
    message: spec.message,
    goal: structuredClone(spec.goal),
    fixtureHash: hashJson(spec),
    score: (finalText, toolTrace) => scoreFixture(
      workspace,
      initialFiles,
      spec.hiddenOracle,
      finalText,
      toolTrace,
    ),
  };
}

async function scoreFixture(
  workspace: string,
  initialFiles: Readonly<Record<string, string>>,
  oracle: HiddenOracle,
  finalText: string,
  toolTrace: readonly WorkerLiveToolTraceEntry[],
): Promise<number> {
  if (await workspaceChanged(workspace, initialFiles)) return 0;
  const answer = canonicalText(finalText);
  if (oracle.forbiddenConcepts.some((value) => containsUnnegatedConcept(answer, value))) {
    return 0;
  }
  const concepts = ratio(oracle.requiredConcepts.filter((alternatives) => (
    alternatives.some((value) => answer.includes(canonicalText(value)))
  )).length, oracle.requiredConcepts.length);
  const reads = ratio(oracle.requiredReads.filter((path) => toolTrace.some((entry) => (
    entry.name === "read_file"
    && normalizeWorkspacePath(entry.arguments.path) === normalizeWorkspacePath(path)
    && !entry.isError
  ))).length, oracle.requiredReads.length);
  return concepts * 0.8 + reads * 0.2;
}

async function workspaceChanged(
  workspace: string,
  initialFiles: Readonly<Record<string, string>>,
): Promise<boolean> {
  for (const [path, content] of Object.entries(initialFiles)) {
    if (await readFile(join(workspace, path), "utf8").catch(() => undefined) !== content) {
      return true;
    }
  }
  return false;
}

function task(
  taskId: string,
  familyId: string,
  kind: WorkerLiveFixtureKind,
  expectedWorkerUse: boolean,
): WorkerLiveTaskPlan {
  return {
    taskId,
    familyId,
    kind,
    fixtureVersion: "worker-live-natural-v2",
    oracle: "hidden",
    expectedWorkerUse,
  };
}

function goal(statement: string, successCriteria: string[]): Goal {
  return {
    version: 1,
    statement,
    successCriteria,
    hardConstraints: ["Do not modify repository files", "Use only repository evidence"],
  };
}

function canonicalText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function containsUnnegatedConcept(answer: string, forbidden: string): boolean {
  const concept = canonicalText(forbidden);
  if (concept.length === 0) return false;
  const escaped = concept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+");
  const matcher = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "giu");
  for (const match of answer.matchAll(matcher)) {
    const start = match.index ?? 0;
    const contextStart = Math.max(0, answer.lastIndexOf(".", start - 1) + 1, answer.lastIndexOf("\n", start - 1) + 1);
    const before = answer.slice(contextStart, start);
    if (!/(?:\b(?:do not|don't|must not|not|never|avoid|without|no)(?:\s+[a-z0-9'-]+){0,3}\s*$|禁止|不要|避免|不得|不能)\s*$/iu.test(before)) {
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
