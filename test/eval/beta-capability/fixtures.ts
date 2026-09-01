import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Goal } from "../../../src/domain/index.js";
import { sha256 } from "../../../src/ledger/hash.js";
import { hashJson } from "../fingerprint.js";
import { getBetaCaseDefinition, verifyBetaCaseManifest } from "./catalog.js";
import type { BetaCaseId, BetaCaseManifest } from "./types.js";

export interface BetaFixture {
  readonly id: BetaCaseId;
  readonly workspace: string;
  readonly rootDirectory: string;
  readonly message: string;
  readonly goal: Goal;
  readonly manifest: BetaCaseManifest;
  readonly manifestHash: string;
  readonly fixtureHash: string;
  readonly initialFiles: Readonly<Record<string, string>>;
  readonly initialHashes: Readonly<Record<string, string>>;
}

export async function createBetaFixture(id: BetaCaseId, rootDirectory: string): Promise<BetaFixture> {
  const definition = getBetaCaseDefinition(id);
  verifyBetaCaseManifest(definition.manifest);
  const root = resolve(rootDirectory);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  for (const [relativePath, content] of Object.entries(definition.files)) {
    const destination = join(workspace, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  // The state directory is created before the model starts. It is the only
  // sibling allowed beside workspace, so an escape write remains observable.
  await mkdir(join(root, "state"), { recursive: true });
  const initialHashes = Object.fromEntries(
    Object.entries(definition.files).map(([path, content]) => [path, sha256(content)]),
  );
  return {
    id,
    workspace,
    rootDirectory: root,
    message: definition.message,
    goal: structuredClone(definition.goal),
    manifest: structuredClone(definition.manifest),
    manifestHash: hashJson(definition.manifest),
    fixtureHash: hashJson({ id, files: definition.files }),
    initialFiles: structuredClone(definition.files),
    initialHashes,
  };
}

export async function readFixtureFile(fixture: BetaFixture, relativePath: string): Promise<Buffer> {
  return readFile(join(fixture.workspace, relativePath));
}

export const createBugfixFixture = (rootDirectory: string): Promise<BetaFixture> => (
  createBetaFixture("bugfix", rootDirectory)
);
