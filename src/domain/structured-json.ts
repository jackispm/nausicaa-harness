/**
 * Extract one JSON object from a provider response that may include a short
 * explanation or a Markdown fence. The caller still owns schema validation.
 */
export function parseSingleJsonObject(content: string): Record<string, unknown> {
  const direct = tryParseObject(content.trim());
  if (direct !== undefined) return direct;

  const candidates: Record<string, unknown>[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "{") continue;
    const end = findObjectEnd(content, index);
    if (end === undefined) continue;
    const candidate = tryParseObject(content.slice(index, end + 1));
    if (candidate !== undefined) {
      candidates.push(candidate);
      index = end;
    }
  }

  if (candidates.length !== 1) {
    throw new StructuredJsonError(
      candidates.length === 0
        ? "Response does not contain one JSON object"
        : "Response contains more than one JSON object",
    );
  }
  return candidates[0]!;
}

export class StructuredJsonError extends Error {
  override readonly name = "StructuredJsonError";
}

function tryParseObject(content: string): Record<string, unknown> | undefined {
  if (content.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function findObjectEnd(content: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}
