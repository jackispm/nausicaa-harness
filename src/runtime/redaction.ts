const DEFAULT_MAX_PERSISTED_ERROR_LENGTH = 1_024;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-or-v1|sk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

export function persistedErrorText(
  error: unknown,
  fallback = "Unknown error",
  maxLength = DEFAULT_MAX_PERSISTED_ERROR_LENGTH,
): string {
  const value = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : fallback;
  return boundedRedactedText(value, maxLength);
}

export function boundedRedactedText(value: string, maxLength: number): string {
  const redacted = redactSensitiveText(value);
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, maxLength - 15))}[TRUNCATED]`;
}

export function stringifyRedactedJson(value: unknown): string {
  return redactSensitiveText(JSON.stringify(value) ?? "null");
}
