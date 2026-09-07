import {
  validateEdgeContextContribution,
  validateEdgeContextContributionSummary,
} from "../mowe/edge-adapter.js";
import type { EdgeRuntimeRegistryLike } from "../runtime/edge-runtime.js";
import { stableJson } from "../ledger/hash.js";

const MAX_SKILL_INVOCATION_BODY_BYTES = 64 * 1024;

export interface SkillInvocationSource {
  snapshot(): unknown;
  readonly loadContribution: NonNullable<EdgeRuntimeRegistryLike["loadContribution"]>;
}

/** Expand a discovered Skill into this request without changing persistent selection. */
export async function expandSkillInvocation(
  text: string,
  source: SkillInvocationSource | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!text.startsWith("/skill:")) return text;
  const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (match === null) throw new Error("Usage: /skill:name [request]");
  if (source === undefined) throw new Error("Skill loading is unavailable in this session");
  signal?.throwIfAborted();
  const reference = match[1]!;
  const request = match[2]?.trim() ?? "";
  const captured = source.snapshot();
  const rows = isRecord(captured) && Array.isArray(captured.contextContributions)
    ? captured.contextContributions
    : [];
  const skills = rows
    .filter((row) => isRecord(row) && row.sourceType === "skill")
    .map((row) => validateEdgeContextContributionSummary(row));
  const exact = skills.find((skill) => `${skill.sourceId}:${skill.contributionId}` === reference);
  const aliases = skills.filter((skill) => skill.name === reference || skill.contributionId === reference);
  if (exact === undefined && aliases.length > 1) {
    throw new Error(`Skill name is ambiguous: ${reference}. Use its source-qualified ID.`);
  }
  const selected = exact ?? aliases[0];
  if (selected === undefined) throw new Error(`Unknown Skill: ${reference}`);
  if (selected.userInvocable === false || (selected.disabled && selected.userInvocable !== true)) {
    throw new Error(`Skill ${selected.name} cannot be invoked by the user`);
  }
  const loaded = await awaitWithSignal(source.loadContribution(selected, {
    snapshot: captured,
    invocation: "user",
    maxBodyBytes: MAX_SKILL_INVOCATION_BODY_BYTES,
    ...(signal === undefined ? {} : { signal }),
  }), signal);
  signal?.throwIfAborted();
  const contribution = validateEdgeContextContribution(loaded);
  if (contribution.sourceType !== "skill"
    || contribution.sourceId !== selected.sourceId
    || contribution.contributionId !== selected.contributionId
    || contribution.name !== selected.name
    || contribution.description !== selected.description
    || contribution.disabled !== selected.disabled
    || contribution.userInvocable !== selected.userInvocable
    || stableJson(contribution.provenance ?? null) !== stableJson(selected.provenance ?? null)
    || (selected.contentHash !== undefined && contribution.contentHash !== selected.contentHash)) {
    throw new Error("Loaded Skill does not match the selected catalog entry");
  }
  if (typeof contribution.body !== "string") throw new Error(`Skill ${selected.name} returned no instructions`);
  if (Buffer.byteLength(contribution.body, "utf8") > MAX_SKILL_INVOCATION_BODY_BYTES) {
    throw new Error(`Skill ${selected.name} exceeds the instruction byte limit`);
  }
  const location = isRecord(loaded) && isRecord(loaded.skillLocation) ? loaded.skillLocation : undefined;
  const filePath = typeof location?.filePath === "string" ? location.filePath : "";
  const baseDirectory = typeof location?.baseDirectory === "string" ? location.baseDirectory : undefined;
  const instructions = baseDirectory === undefined
    ? contribution.body
    : `References are relative to ${JSON.stringify(baseDirectory)}.\n\n${contribution.body}`;
  // Pi/Prime's request-local Skill block; the length makes display parsing
  // unambiguous even if instructions or the user's request contain </skill>.
  const block = `<skill name="${escapeAttribute(selected.name)}" location="${escapeAttribute(filePath)}" instructions-length="${instructions.length}">\n${instructions}\n</skill>`;
  return request.length === 0 ? block : `${block}\n\n${request}`;
}

/** Only condense our exact generated wrapper; this never changes model input. */
export function displaySkillInvocation(text: string): string | undefined {
  const header = /^<skill name="([^"\n]*)" location="[^"\n]*" instructions-length="(\d+)">\n/u.exec(text);
  if (header === null) return undefined;
  const length = Number(header[2]);
  if (!Number.isSafeInteger(length) || length < 0) return undefined;
  const end = header[0].length + length;
  if (text.slice(end, end + 9) !== "\n</skill>") return undefined;
  const suffix = text.slice(end + 9);
  if (suffix.length > 0 && !suffix.startsWith("\n\n")) return undefined;
  const name = unescapeAttribute(header[1]!);
  if (name.length === 0 || /\s/u.test(name)) return undefined;
  return `/skill:${name}${suffix.length === 0 ? "" : ` ${suffix.slice(2)}`}`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;");
}

function unescapeAttribute(value: string): string {
  return value.replaceAll("&#13;", "\r").replaceAll("&#10;", "\n").replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("Skill invocation cancelled"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
