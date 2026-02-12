/**
 * Build OpenAI-compatible tool definitions for vanilla (all downstream tools)
 * and WhiteNoise (4 meta-tools).
 */

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  };
};

type CatalogEntry = {
  fqTool: string;
  description?: string;
  inputSchemaRaw?: unknown;
};

export function getVanillaTools(entries: CatalogEntry[]): OpenAITool[] {
  return entries.map((e) => {
    const schema = (e.inputSchemaRaw as { type?: string; properties?: Record<string, unknown>; required?: string[] }) ?? {};
    return {
      type: 'function' as const,
      function: {
        name: e.fqTool,
        description: e.description ?? '',
        parameters: {
          type: 'object' as const,
          properties: schema.properties ?? {},
          required: schema.required,
        },
      },
    };
  });
}

const META_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'search_tools',
      description: 'Search the downstream tool catalog by name or description',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_modules',
      description: 'List generated TypeScript wrapper modules for downstream tools',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Sub-path within wrappers (optional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_module',
      description: 'Read the source code of a wrapper module (e.g. mcp/servers/everything/echo)',
      parameters: {
        type: 'object',
        properties: {
          specifier: { type: 'string', description: 'Module specifier like mcp/servers/everything/echo' },
        },
        required: ['specifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_code',
      description: 'Execute TypeScript code that can import and call downstream tools. Use imports like: import { echo } from \'mcp/servers/everything/echo\'; then await echo({ message: \'hi\' });',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'TypeScript source to execute' },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000)' },
        },
        required: ['code'],
      },
    },
  },
];

export function getWhiteNoiseTools(): OpenAITool[] {
  return [...META_TOOLS];
}
