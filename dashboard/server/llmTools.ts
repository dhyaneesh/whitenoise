/**
 * Build Gemini-compatible tool definitions for vanilla (all downstream tools)
 * and WhiteNoise (4 meta-tools).
 *
 * Uses @google/genai FunctionDeclaration format.
 */

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

type CatalogEntry = {
  fqTool: string;
  description?: string;
  inputSchemaRaw?: unknown;
};

/**
 * Convert a JSON Schema `type` string (from MCP tool schemas) into a
 * @google/genai Type enum value.
 */
function mapJsonSchemaType(jsonType: string | undefined): string {
  switch (jsonType) {
    case 'string':
      return Type.STRING;
    case 'number':
    case 'integer':
      return Type.NUMBER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'array':
      return Type.ARRAY;
    case 'object':
    default:
      return Type.OBJECT;
  }
}

/**
 * Recursively convert a JSON Schema property definition into
 * a Gemini-compatible schema object.
 */
function convertSchemaProperty(prop: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: mapJsonSchemaType(prop.type as string | undefined),
  };

  if (prop.description) result.description = prop.description;
  if (prop.enum) result.enum = prop.enum;

  // Handle nested object properties
  if (prop.type === 'object' && prop.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(prop.properties as Record<string, Record<string, unknown>>)) {
      properties[key] = convertSchemaProperty(val);
    }
    result.properties = properties;
    if (prop.required) result.required = prop.required;
  }

  // Handle array items
  if (prop.type === 'array' && prop.items) {
    result.items = convertSchemaProperty(prop.items as Record<string, unknown>);
  }

  return result;
}

export function getVanillaTools(entries: CatalogEntry[]): FunctionDeclaration[] {
  return entries.map((e) => {
    const schema = (e.inputSchemaRaw as { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[] }) ?? {};

    const properties: Record<string, unknown> = {};
    if (schema.properties) {
      for (const [key, val] of Object.entries(schema.properties)) {
        properties[key] = convertSchemaProperty(val);
      }
    }

    return {
      name: e.fqTool,
      description: e.description ?? '',
      parameters: {
        type: Type.OBJECT,
        properties,
        required: schema.required,
      },
    } as FunctionDeclaration;
  });
}

const META_TOOLS: FunctionDeclaration[] = [
  {
    name: 'search_tools',
    description:
      'Search the downstream tool catalog by name or description. Each result includes a specifier you can pass to read_module to get the wrapper source.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search term' },
        limit: { type: Type.NUMBER, description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_modules',
    description:
      'List wrapper module specifiers. Use when search_tools does not find what you need (fallback for full context).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Sub-path within wrappers (optional)' },
      },
    },
  },
  {
    name: 'read_module',
    description:
      'Return the source code of a wrapper module. Use the specifier from search_tools results (or from list_modules).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        specifier: { type: Type.STRING, description: 'Module specifier from search_tools or list_modules' },
      },
      required: ['specifier'],
    },
  },
  {
    name: 'execute_code',
    description:
      "Execute TypeScript code that imports wrappers and calls downstream tools. Use specifiers from read_module; e.g. import { echo } from 'mcp/servers/everything/echo'; then await echo({ message: 'hi' });",
    parameters: {
      type: Type.OBJECT,
      properties: {
        code: { type: Type.STRING, description: 'TypeScript source to execute' },
        timeoutMs: { type: Type.NUMBER, description: 'Timeout in ms (default 30000)' },
      },
      required: ['code'],
    },
  },
];

export function getWhiteNoiseTools(): FunctionDeclaration[] {
  return [...META_TOOLS];
}
