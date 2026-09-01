const DEFAULT_MAX_PERSISTED_ERROR_LENGTH = 1_024;
const TRUNCATION_MARKER = "[TRUNCATED]";
const REDACTION_MARKER = "[REDACTED]";

const BASIC_AUTHORIZATION = /(\b(?:proxy[-_])?authorization["']?\s*[:=]\s*["']?basic\s+)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\\"(?:\\.|[^"\\\r\n])*\\"|\\'(?:\\.|[^'\\\r\n])*\\'|[^\s"',;\\]+)/giu;
const BEARER_CREDENTIAL = /Bearer\s+(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\\"(?:\\.|[^"\\\r\n])*\\"|\\'(?:\\.|[^'\\\r\n])*\\'|[^\s"']+)/giu;
const OPENAI_STYLE_KEY = /\b(?:sk-or-v1|sk)-[A-Za-z0-9_-]{12,}\b/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GOOGLE_API_KEY = /\bAIza[A-Za-z0-9_-]{35}\b/g;
const GOOGLE_OAUTH_TOKEN = /\bya29\.[A-Za-z0-9_-]{20,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g;

// Match explicit credential fields, not generic words such as "token" or
// "key". This covers env-style assignments and serialized diagnostic fields.
const SENSITIVE_ASSIGNMENT = /(\b(?:(?:[a-z][a-z0-9]*_)+(?:token|secret|password|passwd|api_key|access_key|private_key|credential)|aws_access_key_id|aws_secret_access_key|aws_session_token|google_api_key|gcp_api_key|azure_storage_key|azure_client_secret|accountkey|sharedaccesssignature|(?:x[-_])?(?:api[-_]key|auth[-_]token|session[-_]token|access[-_]token))["']?\s*[:=]\s*)(\[REDACTED\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\\"(?:\\.|[^"\\\r\n])*\\"|\\'(?:\\.|[^'\\\r\n])*\\'|[^\s,;"'}\]]+)/giu;
const SENSITIVE_CAMEL_CASE_ASSIGNMENT = /(\b(?:apiKey|accessToken|refreshToken|authToken|sessionToken|clientSecret|clientToken|privateKey|secretKey|[a-z][A-Za-z0-9]*(?:ApiKey|AccessToken|RefreshToken|AuthToken|SessionToken|ClientSecret|ClientToken|PrivateKey|SecretKey))["']?\s*[:=]\s*)(\[REDACTED\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\\"(?:\\.|[^"\\\r\n])*\\"|\\'(?:\\.|[^'\\\r\n])*\\'|[^\s,;"'}\]]+)/gu;
const MAX_JSON_REDACTION_DEPTH = 64;
const MAX_JSON_REDACTION_NODES = 50_000;

export function redactSensitiveText(value: string): string {
  const structured = redactJsonText(value);
  return structured === undefined ? redactSensitiveTextPatterns(value) : structured;
}

function redactSensitiveTextPatterns(value: string): string {
  return value
    .replace(BASIC_AUTHORIZATION, redactBasicAuthorization)
    .replace(BEARER_CREDENTIAL, `Bearer ${REDACTION_MARKER}`)
    .replace(OPENAI_STYLE_KEY, REDACTION_MARKER)
    .replace(AWS_ACCESS_KEY_ID, REDACTION_MARKER)
    .replace(GOOGLE_API_KEY, REDACTION_MARKER)
    .replace(GOOGLE_OAUTH_TOKEN, REDACTION_MARKER)
    .replace(JWT, REDACTION_MARKER)
    .replace(SENSITIVE_ASSIGNMENT, redactAssignedValue)
    .replace(SENSITIVE_CAMEL_CASE_ASSIGNMENT, redactAssignedValue);
}

function redactBasicAuthorization(_match: string, prefix: string, assignedValue: string): string {
  if (assignedValue.startsWith("\\\"") && assignedValue.endsWith("\\\"")) {
    return `${prefix}\\\"${REDACTION_MARKER}\\\"`;
  }
  if (assignedValue.startsWith("\\'") && assignedValue.endsWith("\\'")) {
    return `${prefix}\\'${REDACTION_MARKER}\\'`;
  }
  const quote = assignedValue[0];
  return quote === "\"" || quote === "'"
    ? `${prefix}${quote}${REDACTION_MARKER}${quote}`
    : `${prefix}${REDACTION_MARKER}`;
}

function redactAssignedValue(_match: string, prefix: string, assignedValue: string): string {
  if (assignedValue.startsWith("\\\"") && assignedValue.endsWith("\\\"")) {
    return `${prefix}\\\"${REDACTION_MARKER}\\\"`;
  }
  if (assignedValue.startsWith("\\'") && assignedValue.endsWith("\\'")) {
    return `${prefix}\\'${REDACTION_MARKER}\\'`;
  }
  const quote = assignedValue[0];
  return quote === "\"" || quote === "'"
    ? `${prefix}${quote}${REDACTION_MARKER}${quote}`
    : `${prefix}${REDACTION_MARKER}`;
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
  const limit = Number.isFinite(maxLength)
    ? Math.max(0, Math.floor(maxLength))
    : DEFAULT_MAX_PERSISTED_ERROR_LENGTH;
  if (redacted.length <= limit) {
    return redacted;
  }
  if (limit <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, limit);
  }
  return `${redacted.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export function stringifyRedactedJson(value: unknown): string {
  return JSON.stringify(value, (fieldName, child: unknown) => {
    // The replacer runs after an object's `toJSON` hook, matching native
    // JSON.stringify semantics while still scrubbing the resulting values.
    if (fieldName.length > 0 && isSensitiveFieldName(fieldName)) {
      return REDACTION_MARKER;
    }
    return typeof child === "string" ? redactSensitiveTextPatterns(child) : child;
  }) ?? "null";
}

/**
 * Scrub complete JSON with a small lexical parser. It understands escaped
 * strings and object field boundaries while preserving whitespace and numeric
 * lexemes (JSON.parse would round integers outside JavaScript's safe range).
 */
function redactJsonText(value: string): string | undefined {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) return undefined;
  const state: JsonRedactionState = {
    index: value.length - trimmed.length,
    nodes: 0,
    replacements: [],
  };
  if (!scanJsonValue(value, state, 0, true)) return undefined;
  state.index = skipJsonWhitespace(value, state.index);
  if (state.index !== value.length) return undefined;
  if (state.replacements.length === 0) return value;

  let output = "";
  let cursor = 0;
  for (const replacement of state.replacements) {
    output += value.slice(cursor, replacement.start);
    output += replacement.value;
    cursor = replacement.end;
  }
  return `${output}${value.slice(cursor)}`;
}

interface JsonRedactionState {
  index: number;
  nodes: number;
  replacements: JsonRedactionReplacement[];
}

interface JsonRedactionReplacement {
  start: number;
  end: number;
  value: string;
}

function scanJsonValue(
  source: string,
  state: JsonRedactionState,
  depth: number,
  redactStrings: boolean,
): boolean {
  state.index = skipJsonWhitespace(source, state.index);
  state.nodes += 1;
  if (depth > MAX_JSON_REDACTION_DEPTH || state.nodes > MAX_JSON_REDACTION_NODES) return false;
  const marker = source[state.index];
  if (marker === '"') {
    const token = scanJsonString(source, state);
    if (token === undefined || !redactStrings) return token !== undefined;
    const next = redactSensitiveTextPatterns(token.value);
    if (next !== token.value) {
      state.replacements.push({
        start: token.start,
        end: token.end,
        value: JSON.stringify(next),
      });
    }
    return true;
  }
  if (marker === "{") return scanJsonObject(source, state, depth, redactStrings);
  if (marker === "[") return scanJsonArray(source, state, depth, redactStrings);
  if (source.startsWith("true", state.index)) {
    state.index += 4;
    return true;
  }
  if (source.startsWith("false", state.index)) {
    state.index += 5;
    return true;
  }
  if (source.startsWith("null", state.index)) {
    state.index += 4;
    return true;
  }
  const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
    source.slice(state.index),
  );
  if (number === null) return false;
  state.index += number[0].length;
  return true;
}

function scanJsonObject(
  source: string,
  state: JsonRedactionState,
  depth: number,
  redactStrings: boolean,
): boolean {
  state.index += 1;
  state.index = skipJsonWhitespace(source, state.index);
  if (source[state.index] === "}") {
    state.index += 1;
    return true;
  }
  while (state.index < source.length) {
    const key = scanJsonString(source, state);
    if (key === undefined) return false;
    state.index = skipJsonWhitespace(source, state.index);
    if (source[state.index] !== ":") return false;
    state.index += 1;
    state.index = skipJsonWhitespace(source, state.index);
    const valueStart = state.index;
    const keyIsSensitive = redactStrings && isSensitiveFieldName(key.value);
    if (!scanJsonValue(source, state, depth + 1, redactStrings && !keyIsSensitive)) {
      return false;
    }
    if (keyIsSensitive && source.slice(valueStart, state.index) !== JSON.stringify(REDACTION_MARKER)) {
      state.replacements.push({
        start: valueStart,
        end: state.index,
        value: JSON.stringify(REDACTION_MARKER),
      });
    }
    state.index = skipJsonWhitespace(source, state.index);
    if (source[state.index] === "}") {
      state.index += 1;
      return true;
    }
    if (source[state.index] !== ",") return false;
    state.index += 1;
    state.index = skipJsonWhitespace(source, state.index);
  }
  return false;
}

function scanJsonArray(
  source: string,
  state: JsonRedactionState,
  depth: number,
  redactStrings: boolean,
): boolean {
  state.index += 1;
  state.index = skipJsonWhitespace(source, state.index);
  if (source[state.index] === "]") {
    state.index += 1;
    return true;
  }
  while (state.index < source.length) {
    if (!scanJsonValue(source, state, depth + 1, redactStrings)) return false;
    state.index = skipJsonWhitespace(source, state.index);
    if (source[state.index] === "]") {
      state.index += 1;
      return true;
    }
    if (source[state.index] !== ",") return false;
    state.index += 1;
    state.index = skipJsonWhitespace(source, state.index);
  }
  return false;
}

function scanJsonString(
  source: string,
  state: JsonRedactionState,
): { start: number; end: number; value: string } | undefined {
  const start = state.index;
  if (source[start] !== '"') return undefined;
  state.index += 1;
  while (state.index < source.length) {
    const character = source[state.index];
    if (character === undefined) return undefined;
    if (character === '"') {
      state.index += 1;
      const raw = source.slice(start, state.index);
      try {
        const value = JSON.parse(raw);
        return typeof value === "string" ? { start, end: state.index, value } : undefined;
      } catch {
        return undefined;
      }
    }
    if (character === "\\") {
      state.index += 1;
      if (state.index >= source.length) return undefined;
      if (source[state.index] === "u") {
        if (!/^[0-9a-f]{4}/iu.test(source.slice(state.index + 1, state.index + 5))) {
          return undefined;
        }
        state.index += 5;
      } else if (!/["\\/bfnrt]/u.test(source[state.index] ?? "")) {
        return undefined;
      } else {
        state.index += 1;
      }
      continue;
    }
    if (character < "\u0020") return undefined;
    state.index += 1;
  }
  return undefined;
}

function skipJsonWhitespace(source: string, index: number): number {
  while (index < source.length && /[\u0020\u0009\u000a\u000d]/u.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

/**
 * Running the text scrubber on serialized JSON cannot distinguish escaped
 * quotes from JSON syntax and can therefore produce invalid output. The
 * replacer above handles sensitive field names as an additional boundary so
 * opaque credential values do not need a known textual format.
 */
function isSensitiveFieldName(value: string): boolean {
  const normalized = value.replaceAll(/[-\s]/gu, "_").toLowerCase();
  if (
    normalized === "authorization"
    || normalized === "proxy_authorization"
    || normalized === "aws_access_key_id"
    || normalized === "aws_secret_access_key"
    || normalized === "aws_session_token"
    || normalized === "google_api_key"
    || normalized === "gcp_api_key"
    || normalized === "azure_storage_key"
    || normalized === "azure_client_secret"
    || normalized === "accountkey"
    || normalized === "sharedaccesssignature"
  ) {
    return true;
  }
  if (/^(?:x_)?(?:api_key|auth_token|session_token|access_token)$/u.test(normalized)) {
    return true;
  }
  if (/(?:^|_)(?:token|secret|password|passwd|api_key|access_key|private_key|credential)$/u.test(normalized)) {
    return true;
  }
  return /(?:apikey|accesstoken|refreshtoken|authtoken|sessiontoken|clientsecret|clienttoken|privatekey|secretkey|accountkey|sharedaccesssignature)$/u
    .test(normalized);
}
