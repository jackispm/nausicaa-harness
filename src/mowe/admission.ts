import type { AgentTool, JsonSchema } from "../domain/ports.js";

export class MoweAdmissionError extends Error {
  override readonly name = "MoweAdmissionError";
}

export interface AdmissionResult {
  ok: boolean;
  reason?: string;
}

/** Small, deterministic subset of JSON Schema suitable for tool arguments. */
export function validateArguments(tool: AgentTool, value: Record<string, unknown>): AdmissionResult {
  const schema = tool.definition.parameters;
  if (!isRecord(value)) return { ok: false, reason: "Tool arguments must be an object" };
  const result = validateValue(value, schema, "arguments");
  return result === undefined ? { ok: true } : { ok: false, reason: result };
}

export function assertArguments(tool: AgentTool, value: Record<string, unknown>): void {
  const result = validateArguments(tool, value);
  if (!result.ok) throw new MoweAdmissionError(`${tool.definition.name}: ${result.reason ?? "invalid arguments"}`);
}

function validateValue(value: unknown, schema: JsonSchema, path: string): string | undefined {
  const node = schema as unknown as SchemaNode;
  if (node.type !== "object") return validateProperty(value, node, path);
  return validateObject(value, node, path);
}

function validateProperty(value: unknown, schema: unknown, path: string): string | undefined {
  if (!isRecord(schema)) return undefined;
  const node = schema as SchemaNode;

  if (node.const !== undefined && !sameJsonValue(value, node.const)) {
    return `${path} must equal the declared constant`;
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || !node.enum.some((candidate) => sameJsonValue(value, candidate))) {
      return `${path} must be one of the declared values`;
    }
  }

  if (typeof node.type !== "string") return undefined;
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

function validateObject(value: unknown, schema: SchemaNode, path: string): string | undefined {
  if (!isRecord(value)) return `${path} must be an object`;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (!(key in value) || value[key] === undefined) return `${path}.${key} is required`;
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
    if (!(key in value)) continue;
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
      // Invalid provider schemas are left to the tool adapter, preserving the
      // existing permissive behavior for custom AgentTools.
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
  if (Object.is(left, right)) return true;
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
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
