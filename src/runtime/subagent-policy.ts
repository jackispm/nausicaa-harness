import { createHash } from "node:crypto";

/**
 * Keep recursive delegation shallow by default. A caller may opt into a
 * deeper tree, but the host still enforces this absolute bound.
 */
/**
 * Team members may create nested Teams, but the topology stays shallow enough
 * to remain inspectable and to bound scheduler/recovery fan-out.
 */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
export const MAX_SUBAGENT_DEPTH = 64;

/** Agent-message selectors are deliberately short, portable ASCII slugs. */
export const MAX_SUBAGENT_NAME_LENGTH = 64;
export const MIN_SUBAGENT_NAME_LENGTH = 8;

/** Model discovery is a local catalog query, never an unbounded provider call. */
export const DEFAULT_SUBAGENT_MODEL_SEARCH_LIMIT = 8;
export const MAX_SUBAGENT_MODEL_SEARCH_LIMIT = 20;
export const MAX_SUBAGENT_MODEL_CANDIDATES = 1_024;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SAFE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface SubagentDepthDecision {
  readonly depth: number;
  readonly maxDepth: number;
  /** The depth a newly admitted child would use. */
  readonly childDepth: number;
  readonly allowed: boolean;
}

/** Validate a persisted/current subagent depth. */
export function normalizeSubagentDepth(value: unknown, field = "depth"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SUBAGENT_DEPTH) {
    throw new RangeError(`${field} must be an integer between 0 and ${MAX_SUBAGENT_DEPTH}`);
  }
  return value as number;
}

/** Validate an absolute recursion limit independently from the current depth. */
export function normalizeSubagentMaxDepth(value: unknown, field = "maxDepth"): number {
  return normalizeSubagentDepth(value, field);
}

/**
 * Evaluate whether a parent may admit one more child. Invalid values throw so
 * callers cannot accidentally turn malformed durable metadata into a denial
 * that looks like a normal depth-limit decision.
 */
export function evaluateSubagentDepth(
  depth: unknown,
  maxDepth: unknown = DEFAULT_SUBAGENT_MAX_DEPTH,
): SubagentDepthDecision {
  const normalizedDepth = normalizeSubagentDepth(depth);
  const normalizedMaxDepth = normalizeSubagentMaxDepth(maxDepth);
  if (normalizedDepth > normalizedMaxDepth) {
    throw new RangeError(
      `depth (${normalizedDepth}) cannot exceed maxDepth (${normalizedMaxDepth})`,
    );
  }
  return Object.freeze({
    depth: normalizedDepth,
    maxDepth: normalizedMaxDepth,
    childDepth: normalizedDepth + 1,
    allowed: normalizedDepth < normalizedMaxDepth,
  });
}

/** Assert the boundary and return the child depth for an admitted spawn. */
export function assertSubagentSpawnAllowed(
  depth: unknown,
  maxDepth: unknown = DEFAULT_SUBAGENT_MAX_DEPTH,
): number {
  const decision = evaluateSubagentDepth(depth, maxDepth);
  if (!decision.allowed) {
    throw new RangeError(
      `Subagent recursion depth limit reached (depth=${decision.depth}, maxDepth=${decision.maxDepth})`,
    );
  }
  return decision.childDepth;
}

/** Predicate form for admission code that already handles invalid metadata. */
export function canSpawnSubagent(
  depth: unknown,
  maxDepth: unknown = DEFAULT_SUBAGENT_MAX_DEPTH,
): boolean {
  return evaluateSubagentDepth(depth, maxDepth).allowed;
}

export interface SubagentNameOptions {
  readonly maxLength?: number;
}

function normalizeNameLimit(value: number | undefined): number {
  const limit = value ?? MAX_SUBAGENT_NAME_LENGTH;
  if (
    !Number.isSafeInteger(limit)
    || limit < MIN_SUBAGENT_NAME_LENGTH
    || limit > MAX_SUBAGENT_NAME_LENGTH
  ) {
    throw new RangeError(
      `name maxLength must be an integer between ${MIN_SUBAGENT_NAME_LENGTH} and ${MAX_SUBAGENT_NAME_LENGTH}`,
    );
  }
  return limit;
}

function requiredNameInput(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${field} must not be empty`);
  return trimmed;
}

/** Convert arbitrary human text to the safe name alphabet used by selectors. */
function nameSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Normalize an explicit child name. Punctuation and whitespace become a
 * separator, while control characters and overlong names are rejected.
 */
export function normalizeSubagentName(
  value: unknown,
  options: SubagentNameOptions = {},
): string {
  const maxLength = normalizeNameLimit(options.maxLength);
  const normalized = nameSlug(requiredNameInput(value, "name"));
  if (normalized.length === 0) throw new TypeError("name must contain at least one ASCII letter or digit");
  if (normalized === "all" || normalized === "broadcast") {
    throw new TypeError("name is reserved for agent-message routing");
  }
  if (normalized.length > maxLength) {
    throw new RangeError(`name exceeds ${maxLength} characters`);
  }
  if (!SAFE_NAME_PATTERN.test(normalized)) {
    throw new TypeError("name must contain only lowercase letters, digits, and single hyphens");
  }
  return normalized;
}

function requiredChildIdentity(value: unknown, field: string): string {
  return requiredNameInput(value, field);
}

function childIdentitySuffix(childId: string): string {
  const readable = childId
    .replace(/^sub-/iu, "")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase()
    .slice(-8) || "child";
  // Keep a readable tail like Prime while hashing the full id to avoid two ids
  // that happen to share the same visible tail receiving the same name.
  const digest = createHash("sha256").update(childId).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

/**
 * Build a deterministic, readable, collision-resistant default child name.
 * The id/hash suffix is retained when the prompt must be truncated.
 */
export function createCollisionResistantChildName(
  prompt: unknown,
  childId: unknown,
  options: SubagentNameOptions = {},
): string {
  const maxLength = normalizeNameLimit(options.maxLength);
  const promptText = requiredChildIdentity(prompt, "prompt");
  const idText = requiredChildIdentity(childId, "childId");
  const promptPart = nameSlug(promptText) || "worker";
  const suffix = childIdentitySuffix(idText);
  const fixedLength = "subagent-".length + suffix.length + 1;
  const promptBudget = Math.max(1, maxLength - fixedLength);
  const boundedPrompt = promptPart.slice(0, promptBudget).replace(/-+$/g, "") || "worker";
  const candidate = `subagent-${boundedPrompt}-${suffix}`;
  // The lower bound on maxLength leaves enough room for the suffix, but keep a
  // final defensive check if this function is changed alongside the constants.
  if (candidate.length > maxLength) {
    throw new RangeError(`generated child name exceeds ${maxLength} characters`);
  }
  return normalizeSubagentName(candidate, { maxLength });
}

/** Prime-compatible spelling for callers that prefer a generic factory name. */
export const createDefaultSubagentName = createCollisionResistantChildName;

export interface SubagentModelCandidate {
  readonly selector: string;
  readonly provider?: string;
  readonly id?: string;
  readonly name?: string;
}

export interface SubagentModelMatch {
  readonly selector: string;
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

export type SubagentModelInput = string | SubagentModelCandidate;

function normalizeModelSelector(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const selector = value.trim();
  if (
    selector.length === 0
    || selector.length > 256
    || CONTROL_CHARACTER_PATTERN.test(selector)
    || /\s/u.test(selector)
  ) {
    throw new TypeError(`${field} must be a non-empty selector without spaces`);
  }
  return selector;
}

function splitSelector(selector: string): { provider: string; id: string } {
  const colon = selector.indexOf(":");
  const slash = selector.indexOf("/");
  const separator = colon >= 0 ? colon : slash;
  if (separator <= 0 || separator === selector.length - 1) {
    return { provider: "", id: selector };
  }
  return {
    provider: selector.slice(0, separator),
    id: selector.slice(separator + 1),
  };
}

function normalizeModelCandidate(value: SubagentModelInput, index: number): SubagentModelMatch {
  const field = `models[${index}]`;
  if (typeof value === "string") {
    const selector = normalizeModelSelector(value, field);
    const parsed = splitSelector(selector);
    return {
      selector,
      provider: parsed.provider,
      id: parsed.id,
      name: parsed.id,
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be a selector or model candidate`);
  }
  const selector = normalizeModelSelector(value.selector, `${field}.selector`);
  const parsed = splitSelector(selector);
  const provider = value.provider?.trim() || parsed.provider;
  const id = value.id?.trim() || parsed.id;
  const name = value.name?.trim() || id;
  if (provider.length === 0 || id.length === 0 || name.length === 0) {
    throw new TypeError(`${field} must include provider, id, or a parseable selector`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(provider) || CONTROL_CHARACTER_PATTERN.test(id) || CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new TypeError(`${field} metadata must not contain control characters`);
  }
  return { selector, provider, id, name };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeSearchLimit(value: unknown): number {
  const limit = value ?? DEFAULT_SUBAGENT_MODEL_SEARCH_LIMIT;
  if (
    !Number.isSafeInteger(limit)
    || (limit as number) < 1
    || (limit as number) > MAX_SUBAGENT_MODEL_SEARCH_LIMIT
  ) {
    throw new RangeError(
      `model search limit must be an integer between 1 and ${MAX_SUBAGENT_MODEL_SEARCH_LIMIT}`,
    );
  }
  return limit as number;
}

/**
 * Rank and return a bounded set of already-discovered model selectors. This
 * function performs no provider/authentication work and never mutates the
 * supplied catalog.
 */
export function findSubagentModelMatches(
  query: unknown,
  models: readonly SubagentModelInput[],
  limit?: number,
): readonly SubagentModelMatch[] {
  if (typeof query !== "string") throw new TypeError("model search query must be a string");
  if (!Array.isArray(models)) throw new TypeError("models must be an array");
  if (models.length > MAX_SUBAGENT_MODEL_CANDIDATES) {
    throw new RangeError(`models must contain at most ${MAX_SUBAGENT_MODEL_CANDIDATES} candidates`);
  }
  const boundedLimit = normalizeSearchLimit(limit);
  const normalizedQuery = normalizeSearchText(query.trim());
  const seen = new Set<string>();
  const ranked = models
    .map((value, index) => normalizeModelCandidate(value, index))
    .filter((candidate) => {
      const key = candidate.selector.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate) => {
      const fields = [candidate.selector, candidate.id, candidate.name, candidate.provider]
        .map(normalizeSearchText);
      let score = 0;
      if (normalizedQuery.length > 0) {
        const exactIndex = fields.indexOf(normalizedQuery);
        const prefixIndex = fields.findIndex((field) => field.startsWith(normalizedQuery));
        const partialIndex = fields.findIndex((field) => field.includes(normalizedQuery));
        if (exactIndex >= 0) score = exactIndex;
        else if (prefixIndex >= 0) score = 3 + prefixIndex;
        else if (partialIndex >= 0) score = 6 + partialIndex;
        else score = Number.POSITIVE_INFINITY;
      }
      return { candidate, score };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || compareAscii(left.candidate.selector, right.candidate.selector))
    .slice(0, boundedLimit)
    .map(({ candidate }) => Object.freeze(candidate));
  return Object.freeze(ranked);
}

/** String-only projection for delegate/team admission call sites. */
export function searchSubagentModelSelectors(
  query: unknown,
  models: readonly SubagentModelInput[],
  limit?: number,
): readonly string[] {
  return findSubagentModelMatches(query, models, limit).map((match) => match.selector);
}

/** Alias documenting that this operation is intentionally bounded. */
export const findBoundedSubagentModels = findSubagentModelMatches;

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
