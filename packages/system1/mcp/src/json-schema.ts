/**
 * Minimal JSON Schema validator for MCP tool input schemas.
 *
 * MCP servers describe tool arguments with JSON Schema. The adapter validates
 * model-supplied arguments against that schema before dispatch. Only the
 * subset below is supported; anything else fails closed so an unvalidatable
 * schema can never silently pass validation.
 *
 * Supported keywords: `type` (single type name), `properties`, `required`,
 * `additionalProperties`, `items` (single schema), `enum`, `const`, plus the
 * annotation keywords `title`, `description`, `default`, `examples`, and
 * `$schema`, which carry no validation effect.
 *
 * @module @deepseek-ai/dsh-system1-mcp/json-schema
 */

/** Keywords that participate in validation. */
const CHECKED_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

/** Keywords that document the schema without affecting validation. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'default',
  'examples',
  '$schema',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Recursively collect unsupported-keyword violations from a schema.
 * @param schema - the (sub)schema to inspect.
 * @param path - JSON path of the (sub)schema for diagnostics.
 * @param out - collected violation messages.
 */
function checkKeywords(schema: unknown, path: string, out: string[]): void {
  if (typeof schema === 'boolean' || !isRecord(schema)) {
    return
  }
  for (const key of Object.keys(schema)) {
    if (!CHECKED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      out.push(`${path}: unsupported schema keyword "${key}"`)
    }
  }
  const properties = schema.properties
  if (isRecord(properties)) {
    for (const [name, subSchema] of Object.entries(properties)) {
      checkKeywords(subSchema, `${path}.${name}`, out)
    }
  }
  checkKeywords(schema.items, `${path}[]`, out)
}

/**
 * Check that a schema uses only the supported keyword subset.
 * @param schema - the JSON Schema to check.
 * @returns violation messages; empty when the schema is supported.
 */
export function checkSchemaSupport(schema: unknown): string[] {
  if (typeof schema === 'boolean') {
    return []
  }
  if (!isRecord(schema)) {
    return ['$schema: schema must be an object or boolean']
  }
  const out: string[] = []
  checkKeywords(schema, '$', out)
  return out
}

/**
 * Validate a value against a single-named-type schema.
 * @param schema - the enclosing schema (for `properties`/`items`).
 * @param typeName - the value of the schema's `type` keyword.
 * @param value - the value to validate.
 * @param path - JSON path of the value for diagnostics.
 * @param out - collected violation messages.
 */
function validateTyped(
  schema: Record<string, unknown>,
  typeName: unknown,
  value: unknown,
  path: string,
  out: string[],
): void {
  switch (typeName) {
    case 'object':
      validateObject(schema, value, path, out)
      break
    case 'array':
      validateArray(schema, value, path, out)
      break
    case 'string':
    case 'number':
    case 'boolean':
      if (typeof value !== typeName) {
        out.push(`${path}: expected ${typeName}`)
      }
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        out.push(`${path}: expected integer`)
      }
      break
    case 'null':
      if (value !== null) {
        out.push(`${path}: expected null`)
      }
      break
    default:
      out.push(`${path}: unsupported type ${JSON.stringify(typeName)}`)
      break
  }
}

/**
 * Validate a value against an `object` schema.
 * @param schema - the schema node.
 * @param value - the value to validate.
 * @param path - JSON path of the value for diagnostics.
 * @param out - collected violation messages.
 */
function validateObject(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  out: string[],
): void {
  if (!isRecord(value)) {
    out.push(`${path}: expected object`)
    return
  }
  const required = schema.required
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) {
        out.push(`${path}: missing required property "${key}"`)
      }
    }
  }
  const properties = schema.properties
  if (isRecord(properties)) {
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in value) {
        validateNode(subSchema, value[key], `${path}.${key}`, out)
      }
    }
  }
  if (schema.additionalProperties === false) {
    const known = isRecord(properties) ? properties : {}
    for (const key of Object.keys(value)) {
      if (!(key in known)) {
        out.push(`${path}: unexpected property "${key}"`)
      }
    }
  }
}

/**
 * Validate a value against an `array` schema.
 * @param schema - the schema node.
 * @param value - the value to validate.
 * @param path - JSON path of the value for diagnostics.
 * @param out - collected violation messages.
 */
function validateArray(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  out: string[],
): void {
  if (!Array.isArray(value)) {
    out.push(`${path}: expected array`)
    return
  }
  const items = schema.items
  if (items !== undefined) {
    value.forEach((item, index) => {
      validateNode(items, item, `${path}[${index}]`, out)
    })
  }
}

/**
 * Validate a value against one schema node.
 * @param schema - the schema node (object or boolean).
 * @param value - the value to validate.
 * @param path - JSON path of the value for diagnostics.
 * @param out - collected violation messages.
 */
function validateNode(schema: unknown, value: unknown, path: string, out: string[]): void {
  if (typeof schema === 'boolean') {
    if (!schema) {
      out.push(`${path}: boolean schema "false" disallows all values`)
    }
    return
  }
  if (!isRecord(schema)) {
    out.push(`${path}: schema must be an object`)
    return
  }
  if ('const' in schema && !jsonEqual(schema.const, value)) {
    out.push(`${path}: value does not equal the required constant`)
  }
  const allowed = schema.enum
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.some((option) => jsonEqual(option, value)))) {
    out.push(`${path}: value is not one of the allowed values`)
  }
  if (!('type' in schema)) {
    return
  }
  validateTyped(schema, schema.type, value, path, out)
}

/**
 * Validate arguments against a JSON Schema.
 *
 * Schemas using keywords outside the supported subset fail closed: the
 * returned violations name the unsupported keywords instead of silently
 * passing. Check {@link checkSchemaSupport} first when the goal is to reject
 * an unvalidatable schema definition rather than a value.
 * @param schema - the JSON Schema.
 * @param args - the arguments to validate.
 * @returns violation messages; empty when the arguments are valid.
 */
export function validateJsonSchemaArgs(schema: unknown, args: unknown): string[] {
  const unsupported = checkSchemaSupport(schema)
  if (unsupported.length > 0) {
    return unsupported
  }
  const out: string[] = []
  validateNode(schema, args, '$', out)
  return out
}
