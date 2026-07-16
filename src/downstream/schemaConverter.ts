// src/downstream/schemaConverter.ts
import { z } from 'zod';

/**
 * JSON Schema type definition (subset used by MCP tools)
 */
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  additionalProperties?: boolean | JsonSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minItems?: number;
  maxItems?: number;
  nullable?: boolean;
};

type ConvertOptions = {
  /** Root schema for resolving local $ref pointers like #/definitions/Foo */
  root?: JsonSchema & { definitions?: Record<string, JsonSchema>; $defs?: Record<string, JsonSchema> };
  /** Guard against cyclic $ref */
  seen?: Set<string>;
};

function withMeta(schema: z.ZodTypeAny, s: JsonSchema): z.ZodTypeAny {
  let result = schema;

  if (s.description) {
    result = result.describe(s.description);
  }

  if (s.default !== undefined) {
    result = result.default(s.default);
  }

  return result;
}

function resolveRef(
  ref: string,
  root: ConvertOptions['root']
): JsonSchema | undefined {
  if (!root || !ref.startsWith('#/')) return undefined;

  const parts = ref.slice(2).split('/');
  let current: unknown = root;

  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current as JsonSchema | undefined;
}

/**
 * Convert a JSON Schema to a Zod schema.
 * Handles common MCP tool schema patterns including unions, refs, and constraints.
 */
export function jsonSchemaToZod(
  schema: unknown,
  options: ConvertOptions = {}
): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.unknown();
  }

  const s = schema as JsonSchema;
  const root = options.root ?? (s as ConvertOptions['root']);
  const seen = options.seen ?? new Set<string>();
  const opts: ConvertOptions = { root, seen };

  if (s.$ref) {
    if (seen.has(s.$ref)) {
      return z.unknown();
    }
    const resolved = resolveRef(s.$ref, root);
    if (!resolved) {
      return z.unknown();
    }
    seen.add(s.$ref);
    try {
      return jsonSchemaToZod(resolved, opts);
    } finally {
      seen.delete(s.$ref);
    }
  }

  if (s.const !== undefined) {
    return withMeta(z.literal(s.const as string | number | boolean), s);
  }

  if (s.enum && Array.isArray(s.enum) && s.enum.length > 0) {
    const allStrings = s.enum.every((v) => typeof v === 'string');
    if (allStrings) {
      const values = s.enum.map(String) as [string, ...string[]];
      return withMeta(z.enum(values), s);
    }
    if (s.enum.length === 1) {
      return withMeta(
        z.literal(s.enum[0] as string | number | boolean),
        s
      );
    }
    const literals = s.enum.map((v) =>
      z.literal(v as string | number | boolean)
    ) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
    return withMeta(z.union(literals), s);
  }

  if (s.anyOf && s.anyOf.length > 0) {
    return withMeta(unionFrom(s.anyOf, opts), s);
  }

  if (s.oneOf && s.oneOf.length > 0) {
    return withMeta(unionFrom(s.oneOf, opts), s);
  }

  if (s.allOf && s.allOf.length > 0) {
    // Approximate allOf as intersection of converted schemas
    let merged: z.ZodTypeAny = jsonSchemaToZod(s.allOf[0], opts);
    for (let i = 1; i < s.allOf.length; i++) {
      merged = z.intersection(merged, jsonSchemaToZod(s.allOf[i], opts));
    }
    return withMeta(merged, s);
  }

  const types = normalizeTypes(s.type);
  let base: z.ZodTypeAny;

  if (types.length > 1) {
    const variants = types.map((t) => convertByType({ ...s, type: t }, opts));
    base = unionFromSchemas(variants);
  } else if (types.length === 1) {
    base = convertByType({ ...s, type: types[0] }, opts);
  } else if (s.properties) {
    base = convertObject(s, opts);
  } else {
    base = z.unknown();
  }

  if (s.nullable && types.indexOf('null') === -1) {
    base = base.nullable();
  }

  return withMeta(base, s);
}

function normalizeTypes(type: string | string[] | undefined): string[] {
  if (!type) return [];
  return Array.isArray(type) ? type : [type];
}

function unionFrom(schemas: JsonSchema[], opts: ConvertOptions): z.ZodTypeAny {
  return unionFromSchemas(schemas.map((s) => jsonSchemaToZod(s, opts)));
}

function unionFromSchemas(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
  if (schemas.length === 0) return z.unknown();
  if (schemas.length === 1) return schemas[0];
  return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function convertByType(s: JsonSchema, opts: ConvertOptions): z.ZodTypeAny {
  switch (s.type) {
    case 'string':
      return convertString(s);

    case 'number':
      return convertNumber(s, false);

    case 'integer':
      return convertNumber(s, true);

    case 'boolean':
      return z.boolean();

    case 'null':
      return z.null();

    case 'array':
      return convertArray(s, opts);

    case 'object':
      return convertObject(s, opts);

    default:
      if (s.properties) {
        return convertObject(s, opts);
      }
      return z.unknown();
  }
}

function convertString(s: JsonSchema): z.ZodTypeAny {
  let schema = z.string();
  if (typeof s.minLength === 'number') schema = schema.min(s.minLength);
  if (typeof s.maxLength === 'number') schema = schema.max(s.maxLength);
  if (typeof s.pattern === 'string') {
    try {
      schema = schema.regex(new RegExp(s.pattern));
    } catch {
      // Invalid pattern — skip
    }
  }
  return schema;
}

function convertNumber(s: JsonSchema, integer: boolean): z.ZodTypeAny {
  let schema = integer ? z.number().int() : z.number();
  if (typeof s.minimum === 'number') schema = schema.min(s.minimum);
  if (typeof s.maximum === 'number') schema = schema.max(s.maximum);
  if (typeof s.exclusiveMinimum === 'number') {
    schema = schema.gt(s.exclusiveMinimum);
  }
  if (typeof s.exclusiveMaximum === 'number') {
    schema = schema.lt(s.exclusiveMaximum);
  }
  return schema;
}

function convertArray(s: JsonSchema, opts: ConvertOptions): z.ZodTypeAny {
  let itemSchema: z.ZodTypeAny = z.unknown();
  if (s.items) {
    if (Array.isArray(s.items)) {
      // Tuple-style — approximate as union of item types in an array
      itemSchema = unionFrom(s.items, opts);
    } else {
      itemSchema = jsonSchemaToZod(s.items, opts);
    }
  }

  let schema = z.array(itemSchema);
  if (typeof s.minItems === 'number') schema = schema.min(s.minItems);
  if (typeof s.maxItems === 'number') schema = schema.max(s.maxItems);
  return schema;
}

function convertObject(s: JsonSchema, opts: ConvertOptions): z.ZodTypeAny {
  if (!s.properties) {
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      return z.record(jsonSchemaToZod(s.additionalProperties, opts));
    }
    return z.record(z.unknown());
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(s.required ?? []);

  for (const [key, propSchema] of Object.entries(s.properties)) {
    let zodProp = jsonSchemaToZod(propSchema, opts);

    if (!required.has(key)) {
      zodProp = zodProp.optional();
    }

    shape[key] = zodProp;
  }

  const obj = z.object(shape);

  if (s.additionalProperties === false) {
    return obj.strict();
  }

  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    return obj.catchall(jsonSchemaToZod(s.additionalProperties, opts));
  }

  return obj;
}

/**
 * Convert a JSON Schema directly to Zod TypeScript source code.
 * Prefer this over zodToSource(jsonSchemaToZod(...)) — avoids Zod internals.
 */
export function jsonSchemaToSource(
  schema: unknown,
  options: ConvertOptions = {}
): string {
  if (!schema || typeof schema !== 'object') {
    return 'z.unknown()';
  }

  const s = schema as JsonSchema;
  const root = options.root ?? (s as ConvertOptions['root']);
  const seen = options.seen ?? new Set<string>();
  const opts: ConvertOptions = { root, seen };

  let source = jsonSchemaToSourceInternal(s, opts);
  source = withMetaSource(source, s);
  return source;
}

function withMetaSource(source: string, s: JsonSchema): string {
  let result = source;

  if (s.description) {
    result += `.describe(${JSON.stringify(s.description)})`;
  }

  if (s.default !== undefined) {
    result += `.default(${JSON.stringify(s.default)})`;
  }

  return result;
}

function jsonSchemaToSourceInternal(
  s: JsonSchema,
  opts: ConvertOptions
): string {
  if (s.$ref) {
    if (opts.seen?.has(s.$ref)) {
      return 'z.unknown()';
    }
    const resolved = resolveRef(s.$ref, opts.root);
    if (!resolved) return 'z.unknown()';
    opts.seen!.add(s.$ref);
    try {
      return jsonSchemaToSourceInternal(resolved, opts);
    } finally {
      opts.seen!.delete(s.$ref);
    }
  }

  if (s.const !== undefined) {
    return `z.literal(${JSON.stringify(s.const)})`;
  }

  if (s.enum && Array.isArray(s.enum) && s.enum.length > 0) {
    const allStrings = s.enum.every((v) => typeof v === 'string');
    if (allStrings) {
      const valuesStr = s.enum.map((v) => JSON.stringify(v)).join(', ');
      return `z.enum([${valuesStr}])`;
    }
    const literals = s.enum
      .map((v) => `z.literal(${JSON.stringify(v)})`)
      .join(', ');
    return `z.union([${literals}])`;
  }

  if (s.anyOf && s.anyOf.length > 0) {
    return unionSource(s.anyOf, opts);
  }

  if (s.oneOf && s.oneOf.length > 0) {
    return unionSource(s.oneOf, opts);
  }

  if (s.allOf && s.allOf.length > 0) {
    const parts = s.allOf.map((part) => jsonSchemaToSource(part, opts));
    return parts.reduce((acc, cur) => `z.intersection(${acc}, ${cur})`);
  }

  const types = normalizeTypes(s.type);
  let source: string;

  if (types.length > 1) {
    const variants = types.map((t) =>
      typeToSource({ ...s, type: t, description: undefined, default: undefined }, opts)
    );
    source =
      variants.length === 1
        ? variants[0]
        : `z.union([${variants.join(', ')}])`;
  } else if (types.length === 1) {
    source = typeToSource(
      { ...s, description: undefined, default: undefined },
      opts
    );
  } else if (s.properties) {
    source = objectToSource(s, opts);
  } else {
    source = 'z.unknown()';
  }

  if (s.nullable && types.indexOf('null') === -1) {
    source += '.nullable()';
  }

  return source;
}

function unionSource(schemas: JsonSchema[], opts: ConvertOptions): string {
  if (schemas.length === 0) return 'z.unknown()';
  if (schemas.length === 1) return jsonSchemaToSource(schemas[0], opts);
  const parts = schemas.map((part) => jsonSchemaToSource(part, opts));
  return `z.union([${parts.join(', ')}])`;
}

function typeToSource(s: JsonSchema, opts: ConvertOptions): string {
  switch (s.type) {
    case 'string':
      return stringToSource(s);

    case 'number':
      return numberToSource(s, false);

    case 'integer':
      return numberToSource(s, true);

    case 'boolean':
      return 'z.boolean()';

    case 'null':
      return 'z.null()';

    case 'array':
      return arrayToSource(s, opts);

    case 'object':
      return objectToSource(s, opts);

    default:
      if (s.properties) return objectToSource(s, opts);
      return 'z.unknown()';
  }
}

function stringToSource(s: JsonSchema): string {
  let source = 'z.string()';
  if (typeof s.minLength === 'number') source += `.min(${s.minLength})`;
  if (typeof s.maxLength === 'number') source += `.max(${s.maxLength})`;
  if (typeof s.pattern === 'string') {
    try {
      // Validate the pattern compiles; emit as RegExp literal via JSON string
      new RegExp(s.pattern);
      source += `.regex(new RegExp(${JSON.stringify(s.pattern)}))`;
    } catch {
      // skip invalid pattern
    }
  }
  return source;
}

function numberToSource(s: JsonSchema, integer: boolean): string {
  let source = integer ? 'z.number().int()' : 'z.number()';
  if (typeof s.minimum === 'number') source += `.min(${s.minimum})`;
  if (typeof s.maximum === 'number') source += `.max(${s.maximum})`;
  if (typeof s.exclusiveMinimum === 'number') {
    source += `.gt(${s.exclusiveMinimum})`;
  }
  if (typeof s.exclusiveMaximum === 'number') {
    source += `.lt(${s.exclusiveMaximum})`;
  }
  return source;
}

function arrayToSource(s: JsonSchema, opts: ConvertOptions): string {
  let itemSource = 'z.unknown()';
  if (s.items) {
    if (Array.isArray(s.items)) {
      itemSource = unionSource(s.items, opts);
    } else {
      itemSource = jsonSchemaToSource(s.items, opts);
    }
  }

  let source = `z.array(${itemSource})`;
  if (typeof s.minItems === 'number') source += `.min(${s.minItems})`;
  if (typeof s.maxItems === 'number') source += `.max(${s.maxItems})`;
  return source;
}

function objectToSource(s: JsonSchema, opts: ConvertOptions): string {
  if (!s.properties) {
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      return `z.record(${jsonSchemaToSource(s.additionalProperties, opts)})`;
    }
    return 'z.record(z.unknown())';
  }

  const required = new Set(s.required ?? []);
  const entries = Object.entries(s.properties);

  if (entries.length === 0) {
    let empty = 'z.object({})';
    if (s.additionalProperties === false) empty += '.strict()';
    return empty;
  }

  const props = entries
    .map(([key, propSchema]) => {
      let propSource = jsonSchemaToSource(propSchema, opts);
      if (!required.has(key)) {
        propSource += '.optional()';
      }
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
        ? key
        : JSON.stringify(key);
      return `  ${safeKey}: ${propSource}`;
    })
    .join(',\n');

  let source = `z.object({\n${props}\n})`;

  if (s.additionalProperties === false) {
    source += '.strict()';
  } else if (
    s.additionalProperties &&
    typeof s.additionalProperties === 'object'
  ) {
    source += `.catchall(${jsonSchemaToSource(s.additionalProperties, opts)})`;
  }

  return source;
}

/**
 * @deprecated Prefer jsonSchemaToSource for generation. Kept for callers that
 * already hold a Zod schema. Uses a public-ish traversal via Zod's typeName.
 */
export function zodToSource(schema: z.ZodTypeAny): string {
  return zodToSourceInternal(schema);
}

function zodToSourceInternal(schema: z.ZodTypeAny): string {
  const def = schema._def as {
    typeName: string;
    innerType?: z.ZodTypeAny;
    type?: z.ZodTypeAny;
    values?: string[];
    valueType?: z.ZodTypeAny;
    shape?: () => Record<string, z.ZodTypeAny>;
    description?: string;
    defaultValue?: () => unknown;
  };

  let source: string;

  if (def.typeName === 'ZodOptional') {
    source = `${zodToSourceInternal(def.innerType!)}.optional()`;
  } else if (def.typeName === 'ZodNullable') {
    source = `${zodToSourceInternal(def.innerType!)}.nullable()`;
  } else if (def.typeName === 'ZodDefault') {
    const inner = zodToSourceInternal(def.innerType!);
    const defaultVal =
      typeof def.defaultValue === 'function' ? def.defaultValue() : undefined;
    source = `${inner}.default(${JSON.stringify(defaultVal)})`;
  } else {
    switch (def.typeName) {
      case 'ZodString':
        source = 'z.string()';
        break;

      case 'ZodNumber':
        source = 'z.number()';
        break;

      case 'ZodBoolean':
        source = 'z.boolean()';
        break;

      case 'ZodNull':
        source = 'z.null()';
        break;

      case 'ZodUnknown':
        source = 'z.unknown()';
        break;

      case 'ZodAny':
        source = 'z.any()';
        break;

      case 'ZodArray': {
        const itemSource = zodToSourceInternal(def.type!);
        source = `z.array(${itemSource})`;
        break;
      }

      case 'ZodEnum': {
        const values = def.values as string[];
        const valuesStr = values.map((v) => JSON.stringify(v)).join(', ');
        source = `z.enum([${valuesStr}])`;
        break;
      }

      case 'ZodRecord': {
        const valueSource = zodToSourceInternal(def.valueType!);
        source = `z.record(${valueSource})`;
        break;
      }

      case 'ZodObject': {
        const shape = def.shape!() as Record<string, z.ZodTypeAny>;
        const entries = Object.entries(shape);

        if (entries.length === 0) {
          source = 'z.object({})';
        } else {
          const props = entries
            .map(([key, value]) => {
              const propSource = zodToSourceInternal(value);
              const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
                ? key
                : JSON.stringify(key);
              return `  ${safeKey}: ${propSource}`;
            })
            .join(',\n');
          source = `z.object({\n${props}\n})`;
        }
        break;
      }

      default:
        source = 'z.unknown()';
    }
  }

  if (def.description) {
    source += `.describe(${JSON.stringify(def.description)})`;
  }

  return source;
}
