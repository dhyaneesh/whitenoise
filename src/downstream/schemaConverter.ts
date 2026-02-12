// src/downstream/schemaConverter.ts
import { z } from 'zod';

/**
 * JSON Schema type definition (subset used by MCP tools)
 */
type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
};

/**
 * Convert a JSON Schema to a Zod schema.
 * Handles common MCP tool schema patterns.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.unknown();
  }

  const s = schema as JsonSchema;

  // Handle enum types
  if (s.enum && Array.isArray(s.enum) && s.enum.length > 0) {
    const values = s.enum as [string, ...string[]];
    return z.enum(values.map(String) as [string, ...string[]]);
  }

  switch (s.type) {
    case 'string':
      return z.string();

    case 'number':
    case 'integer':
      return z.number();

    case 'boolean':
      return z.boolean();

    case 'null':
      return z.null();

    case 'array':
      if (s.items) {
        return z.array(jsonSchemaToZod(s.items));
      }
      return z.array(z.unknown());

    case 'object':
      return convertObject(s);

    default:
      // If no type but has properties, treat as object
      if (s.properties) {
        return convertObject(s);
      }
      return z.unknown();
  }
}

function convertObject(s: JsonSchema): z.ZodTypeAny {
  if (!s.properties) {
    return z.record(z.unknown());
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(s.required ?? []);

  for (const [key, propSchema] of Object.entries(s.properties)) {
    let zodProp = jsonSchemaToZod(propSchema);

    if (!required.has(key)) {
      zodProp = zodProp.optional();
    }

    shape[key] = zodProp;
  }

  return z.object(shape);
}

/**
 * Convert a Zod schema to TypeScript source code.
 * Used for generating schema files.
 */
export function zodToSource(schema: z.ZodTypeAny): string {
  return zodToSourceInternal(schema);
}

function zodToSourceInternal(schema: z.ZodTypeAny): string {
  const def = schema._def;

  // Check for ZodOptional
  if (def.typeName === 'ZodOptional') {
    const inner = zodToSourceInternal(def.innerType);
    return `${inner}.optional()`;
  }

  // Check for ZodNullable
  if (def.typeName === 'ZodNullable') {
    const inner = zodToSourceInternal(def.innerType);
    return `${inner}.nullable()`;
  }

  switch (def.typeName) {
    case 'ZodString':
      return 'z.string()';

    case 'ZodNumber':
      return 'z.number()';

    case 'ZodBoolean':
      return 'z.boolean()';

    case 'ZodNull':
      return 'z.null()';

    case 'ZodUnknown':
      return 'z.unknown()';

    case 'ZodAny':
      return 'z.any()';

    case 'ZodArray': {
      const itemSource = zodToSourceInternal(def.type);
      return `z.array(${itemSource})`;
    }

    case 'ZodEnum': {
      const values = def.values as string[];
      const valuesStr = values.map(v => JSON.stringify(v)).join(', ');
      return `z.enum([${valuesStr}])`;
    }

    case 'ZodRecord': {
      const valueSource = zodToSourceInternal(def.valueType);
      return `z.record(${valueSource})`;
    }

    case 'ZodObject': {
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      const entries = Object.entries(shape);

      if (entries.length === 0) {
        return 'z.object({})';
      }

      const props = entries
        .map(([key, value]) => {
          const propSource = zodToSourceInternal(value);
          // Use quoted key if needed
          const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
            ? key
            : JSON.stringify(key);
          return `  ${safeKey}: ${propSource}`;
        })
        .join(',\n');

      return `z.object({\n${props}\n})`;
    }

    default:
      // Fallback for unknown types
      return 'z.unknown()';
  }
}
