import type { AgentTool } from "../domain/ports.js";

export class MoweAdmissionError extends Error {
  override readonly name = "MoweAdmissionError";

  readonly diagnostic?: AdmissionDiagnostic;

  constructor(message: string, diagnostic?: AdmissionDiagnostic) {
    super(message);
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
  }
}

export type AdmissionFailureCode =
  | "invalid_arguments"
  | "invalid_schema"
  | "unsupported_schema";

export interface AdmissionDiagnostic {
  readonly code: AdmissionFailureCode;
  readonly path: string;
  readonly keyword?: string;
  readonly detail?: string;
  readonly message: string;
}

export interface AdmissionResult {
  ok: boolean;
  reason?: string;
  diagnostic?: AdmissionDiagnostic;
}

export interface SchemaInspectionOptions {
  /** Edge manifests and AgentTool roots must be object schemas. */
  readonly requireObjectRoot?: boolean;
  /**
   * Reject an object-level additionalProperties declaration without an
   * explicit properties map. Legacy AgentTools intentionally keep that shape
   * open; edge manifests must not publish a constraint the runtime cannot
   * apply to unknown keys.
   */
  readonly requirePropertiesForAdditionalProperties?: boolean;
}

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const MAX_SCHEMA_INSPECTION_DEPTH = 64;
const MAX_SCHEMA_INSPECTION_NODES = 50_000;

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "minimum",
  "minItems",
  "minLength",
  "pattern",
  "properties",
  "required",
  "type",
]);

// Annotation keywords do not alter admission and are safe to retain. Any
// other keyword could encode an unenforced constraint, so it fails closed.
const SCHEMA_ANNOTATION_KEYWORDS = new Set([
  "$anchor",
  "$comment",
  "$id",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

/** Small, deterministic subset of JSON Schema suitable for tool arguments. */
export function validateArguments(tool: AgentTool, value: Record<string, unknown>): AdmissionResult {
  const schema = tool.definition.parameters;
  const schemaDiagnostic = inspectSchema(schema, "parameters", { requireObjectRoot: true });
  if (schemaDiagnostic !== undefined) return admissionFailure(schemaDiagnostic);
  if (!isRecord(value)) return { ok: false, reason: "Tool arguments must be an object" };
  const result = validateProperty(value, schema, "arguments");
  return result === undefined ? { ok: true } : { ok: false, reason: result };
}

export function assertArguments(tool: AgentTool, value: Record<string, unknown>): void {
  const result = validateArguments(tool, value);
  if (!result.ok) {
    throw new MoweAdmissionError(
      `${tool.definition.name}: ${result.reason ?? "invalid arguments"}`,
      result.diagnostic,
    );
  }
}

/**
 * Inspect a schema without executing it.  This is shared by runtime argument
 * admission and edge-manifest normalization so discovery cannot publish a
 * contract that execution would silently ignore.
 */
export function inspectSchema(
  schema: unknown,
  path = "parameters",
  options: SchemaInspectionOptions = {},
): AdmissionDiagnostic | undefined {
  return inspectSchemaNode(
    schema,
    path,
    { ancestors: new Set<object>(), nodes: 0 },
    0,
    options.requireObjectRoot !== false,
    options.requirePropertiesForAdditionalProperties === true,
  );
}

/** Throw the same structured admission error used by argument validation. */
export function assertSupportedSchema(
  schema: unknown,
  path = "parameters",
  options: SchemaInspectionOptions = {},
): void {
  const diagnostic = inspectSchema(schema, path, options);
  if (diagnostic !== undefined) throw new MoweAdmissionError(diagnostic.message, diagnostic);
}

function validateProperty(value: unknown, schema: unknown, path: string): string | undefined {
  if (schema === true) return undefined;
  if (schema === false) return `${path} is rejected by the declared schema`;
  if (!isRecord(schema)) return undefined;
  const node = schema as SchemaNode;

  if (hasOwn(node, "const") && !sameJsonValue(value, node.const)) {
    return `${path} must equal the declared constant`;
  }
  if (hasOwn(node, "enum")) {
    if (!Array.isArray(node.enum) || !node.enum.some((candidate) => sameJsonValue(value, candidate))) {
      return `${path} must be one of the declared values`;
    }
  }

  if (typeof node.type !== "string") {
    if (isRecord(value) && hasObjectConstraint(node)) return validateObject(value, node, path);
    if (Array.isArray(value) && hasArrayConstraint(node)) return validateArray(value, node, path);
    if (typeof value === "string" && hasStringConstraint(node)) return validateString(value, node, path);
    if (typeof value === "number" && Number.isFinite(value) && hasNumberConstraint(node)) {
      return validateNumber(value, node, path);
    }
    return undefined;
  }
  const type = node.type;
  const valid = type === "string" ? typeof value === "string"
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "boolean" ? typeof value === "boolean"
          : type === "null" ? value === null
            : type === "array" ? Array.isArray(value)
              : type === "object" ? isRecord(value) : true;
  if (!valid) return `${path} must be ${type}`;

  if (type === "string") return validateString(value as string, node, path);
  if (type === "number" || type === "integer") return validateNumber(value as number, node, path);
  if (type === "array") return validateArray(value as unknown[], node, path);
  if (type === "object") return validateObject(value, node, path);
  return undefined;
}

interface SchemaNode {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  enum?: unknown;
  const?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
}

function inspectSchemaNode(
  schema: unknown,
  path: string,
  state: SchemaInspectionState,
  depth: number,
  requireObjectRoot = false,
  requirePropertiesForAdditionalProperties = false,
): AdmissionDiagnostic | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_INSPECTION_NODES) {
    return schemaDiagnostic(
      "invalid_schema",
      path,
      "schema",
      `must not exceed ${MAX_SCHEMA_INSPECTION_NODES} schema nodes`,
    );
  }
  if (depth > MAX_SCHEMA_INSPECTION_DEPTH) {
    return schemaDiagnostic(
      "invalid_schema",
      path,
      "schema",
      `must not exceed schema depth ${MAX_SCHEMA_INSPECTION_DEPTH}`,
    );
  }
  if (typeof schema === "boolean") {
    return requireObjectRoot
      ? schemaDiagnostic("invalid_schema", path, "schema", "root schema must be an object")
      : undefined;
  }
  if (!isRecord(schema)) {
    return schemaDiagnostic("invalid_schema", path, "schema", "must be an object or boolean schema");
  }
  if (state.ancestors.has(schema)) {
    return schemaDiagnostic("invalid_schema", path, "schema", "cyclic schema objects are not supported");
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return schemaDiagnostic(
      "unsupported_schema",
      `${path}.type`,
      "type",
      "type arrays are not implemented",
    );
  }
  if (hasOwn(schema, "type") && (typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))) {
    return schemaDiagnostic(
      "invalid_schema",
      `${path}.type`,
      "type",
      "must be one supported JSON Schema type",
    );
  }
  if (requireObjectRoot && type !== "object") {
    return schemaDiagnostic("invalid_schema", `${path}.type`, "type", "root schema type must equal object");
  }

  const unsupported = Object.keys(schema)
    .sort()
    .find((keyword) => !SUPPORTED_SCHEMA_KEYWORDS.has(keyword)
      && !SCHEMA_ANNOTATION_KEYWORDS.has(keyword));
  if (unsupported !== undefined) {
    return schemaDiagnostic(
      "unsupported_schema",
      `${path}.${unsupported}`,
      unsupported,
      `keyword ${JSON.stringify(unsupported)} is not implemented`,
    );
  }

  const shapeDiagnostic = inspectKeywordShapes(schema, path);
  if (shapeDiagnostic !== undefined) return shapeDiagnostic;
  if (
    requirePropertiesForAdditionalProperties
    && hasOwn(schema, "additionalProperties")
    && schema.additionalProperties !== true
    && !hasOwn(schema, "properties")
  ) {
    return schemaDiagnostic(
      "unsupported_schema",
      `${path}.additionalProperties`,
      "additionalProperties",
      "additionalProperties requires an explicit properties object at the edge boundary",
    );
  }

  state.ancestors.add(schema);
  try {
    if (hasOwn(schema, "properties")) {
      for (const key of Object.keys(schema.properties as Record<string, unknown>).sort()) {
        const diagnostic = inspectSchemaNode(
          (schema.properties as Record<string, unknown>)[key],
          `${path}.properties.${key}`,
          state,
          depth + 1,
          false,
          requirePropertiesForAdditionalProperties,
        );
        if (diagnostic !== undefined) return diagnostic;
      }
    }
    if (isRecord(schema.additionalProperties)) {
      const diagnostic = inspectSchemaNode(
        schema.additionalProperties,
        `${path}.additionalProperties`,
        state,
        depth + 1,
        false,
        requirePropertiesForAdditionalProperties,
      );
      if (diagnostic !== undefined) return diagnostic;
    }
    if (hasOwn(schema, "items")) {
      const diagnostic = inspectSchemaNode(
        schema.items,
        `${path}.items`,
        state,
        depth + 1,
        false,
        requirePropertiesForAdditionalProperties,
      );
      if (diagnostic !== undefined) return diagnostic;
    }
    return undefined;
  } finally {
    state.ancestors.delete(schema);
  }
}

interface SchemaInspectionState {
  readonly ancestors: Set<object>;
  nodes: number;
}

function inspectKeywordShapes(
  schema: Readonly<Record<string, unknown>>,
  path: string,
): AdmissionDiagnostic | undefined {
  if (hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      return schemaDiagnostic("invalid_schema", `${path}.enum`, "enum", "must be a non-empty array");
    }
    const values = new Set<string>();
    for (let index = 0; index < schema.enum.length; index += 1) {
      if (!isJsonValue(schema.enum[index])) {
        return schemaDiagnostic(
          "invalid_schema",
          `${path}.enum[${index}]`,
          "enum",
          "must contain only JSON values",
        );
      }
      const identity = canonicalJson(schema.enum[index]);
      if (values.has(identity)) {
        return schemaDiagnostic(
          "invalid_schema",
          `${path}.enum[${index}]`,
          "enum",
          "must contain unique JSON values",
        );
      }
      values.add(identity);
    }
  }
  if (hasOwn(schema, "const") && !isJsonValue(schema.const)) {
    return schemaDiagnostic(
      "invalid_schema",
      `${path}.const`,
      "const",
      "must be a JSON value",
    );
  }
  if (hasOwn(schema, "pattern")) {
    if (typeof schema.pattern !== "string") {
      return schemaDiagnostic("invalid_schema", `${path}.pattern`, "pattern", "must be a string");
    }
    try {
      // Keep the same Unicode-aware behavior used by runtime admission.
      new RegExp(schema.pattern, "u");
    } catch {
      return schemaDiagnostic("invalid_schema", `${path}.pattern`, "pattern", "must be a valid regular expression");
    }
  }
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (!hasOwn(schema, keyword)) continue;
    if (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword])) {
      return schemaDiagnostic(
        "invalid_schema",
        `${path}.${keyword}`,
        keyword,
        "must be a finite number",
      );
    }
  }
  for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (!hasOwn(schema, keyword)) continue;
    if (!Number.isSafeInteger(schema[keyword]) || (schema[keyword] as number) < 0) {
      return schemaDiagnostic(
        "invalid_schema",
        `${path}.${keyword}`,
        keyword,
        "must be a non-negative safe integer",
      );
    }
  }
  if (hasOwn(schema, "properties") && !isRecord(schema.properties)) {
    return schemaDiagnostic("invalid_schema", `${path}.properties`, "properties", "must be an object");
  }
  if (hasOwn(schema, "required")) {
    if (!Array.isArray(schema.required)) {
      return schemaDiagnostic(
        "invalid_schema",
        `${path}.required`,
        "required",
        "must be an array of unique strings",
      );
    }
    for (let index = 0; index < schema.required.length; index += 1) {
      if (!(index in schema.required) || typeof schema.required[index] !== "string") {
        return schemaDiagnostic(
          "invalid_schema",
          `${path}.required[${index}]`,
          "required",
          "must be a dense array of unique strings",
        );
      }
    }
    if (new Set(schema.required).size !== schema.required.length) {
      return schemaDiagnostic(
        "invalid_schema",
        `${path}.required`,
        "required",
        "must be an array of unique strings",
      );
    }
  }
  if (hasOwn(schema, "additionalProperties")
    && typeof schema.additionalProperties !== "boolean"
    && !isRecord(schema.additionalProperties)) {
    return schemaDiagnostic(
      "invalid_schema",
      `${path}.additionalProperties`,
      "additionalProperties",
      "must be a boolean or schema object",
    );
  }
  if (Array.isArray(schema.items)) {
    return schemaDiagnostic(
      "unsupported_schema",
      `${path}.items`,
      "items",
      "tuple-form items arrays are not implemented",
    );
  }
  if (hasOwn(schema, "items")
    && typeof schema.items !== "boolean"
    && !isRecord(schema.items)) {
    return schemaDiagnostic(
      "invalid_schema",
      `${path}.items`,
      "items",
      "must be a boolean or schema object",
    );
  }
  return undefined;
}

function schemaDiagnostic(
  code: "invalid_schema" | "unsupported_schema",
  path: string,
  keyword: string,
  detail: string,
): AdmissionDiagnostic {
  return {
    code,
    path,
    keyword,
    detail,
    message: `Tool schema at ${path} is not supported: ${detail}`,
  };
}

function admissionFailure(diagnostic: AdmissionDiagnostic): AdmissionResult {
  return { ok: false, reason: diagnostic.message, diagnostic };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > MAX_SCHEMA_INSPECTION_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  if (!isRecord(value) && !Array.isArray(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !isJsonValue(value[index], seen, depth + 1)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = Object.values(value).every((item) => isJsonValue(item, seen, depth + 1));
  }
  seen.delete(value);
  return valid;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hasObjectConstraint(schema: SchemaNode): boolean {
  return hasOwn(schema, "properties")
    || hasOwn(schema, "required")
    || hasOwn(schema, "additionalProperties");
}

function hasArrayConstraint(schema: SchemaNode): boolean {
  return hasOwn(schema, "items") || hasOwn(schema, "minItems") || hasOwn(schema, "maxItems");
}

function hasStringConstraint(schema: SchemaNode): boolean {
  return hasOwn(schema, "pattern") || hasOwn(schema, "minLength") || hasOwn(schema, "maxLength");
}

function hasNumberConstraint(schema: SchemaNode): boolean {
  return hasOwn(schema, "minimum")
    || hasOwn(schema, "maximum")
    || hasOwn(schema, "exclusiveMinimum")
    || hasOwn(schema, "exclusiveMaximum");
}

function validateObject(value: unknown, schema: SchemaNode, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      return `${path}.${key} is required`;
    }
  }

  // A legacy ToolDefinition may intentionally omit `properties` while still
  // setting additionalProperties. Treat that as an open argument envelope so
  // Mowe does not tighten an existing AgentTool contract unexpectedly.
  if (schema.additionalProperties === false && properties !== undefined) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) return `${path}.${key} is not allowed`;
    }
  }
  for (const [key, propertySchema] of Object.entries(properties ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const error = validateProperty(value[key], propertySchema, `${path}.${key}`);
    if (error !== undefined) return error;
  }
  if (schema.additionalProperties !== false && properties !== undefined
    && isRecord(schema.additionalProperties)) {
    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      const error = validateProperty(value[key], schema.additionalProperties, `${path}.${key}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
}

function validateString(value: string, schema: SchemaNode, path: string): string | undefined {
  const length = [...value].length;
  const minLength = nonnegativeInteger(schema.minLength);
  if (minLength !== undefined && length < minLength) return `${path} must contain at least ${minLength} characters`;
  const maxLength = nonnegativeInteger(schema.maxLength);
  if (maxLength !== undefined && length > maxLength) return `${path} must contain at most ${maxLength} characters`;
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern, "u").test(value)) return `${path} must match the declared pattern`;
    } catch {
      return `${path} declares an invalid pattern`;
    }
  }
  return undefined;
}

function validateNumber(value: number, schema: SchemaNode, path: string): string | undefined {
  const minimum = finiteNumber(schema.minimum);
  if (minimum !== undefined && value < minimum) return `${path} must be greater than or equal to ${minimum}`;
  const maximum = finiteNumber(schema.maximum);
  if (maximum !== undefined && value > maximum) return `${path} must be less than or equal to ${maximum}`;
  const exclusiveMinimum = finiteNumber(schema.exclusiveMinimum);
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) return `${path} must be greater than ${exclusiveMinimum}`;
  const exclusiveMaximum = finiteNumber(schema.exclusiveMaximum);
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) return `${path} must be less than ${exclusiveMaximum}`;
  return undefined;
}

function validateArray(value: unknown[], schema: SchemaNode, path: string): string | undefined {
  const minItems = nonnegativeInteger(schema.minItems);
  if (minItems !== undefined && value.length < minItems) return `${path} must contain at least ${minItems} items`;
  const maxItems = nonnegativeInteger(schema.maxItems);
  if (maxItems !== undefined && value.length > maxItems) return `${path} must contain at most ${maxItems} items`;
  if (schema.items === undefined) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const error = validateProperty(value[index], schema.items, `${path}[${index}]`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameJsonValue(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
