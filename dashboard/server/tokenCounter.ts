/**
 * Naive token count: ~4 chars per token (GPT-style approximation).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Vanilla MCP: full list of tools with name, description, inputSchema.
 * WhiteNoise: only 4 meta-tools with small schemas.
 */
const META_TOOL_SCHEMAS = [
  {
    name: 'search_tools',
    description: 'Search the downstream tool catalog by name or description',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'list_modules',
    description: 'List all generated wrapper modules for downstream tools',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'read_module',
    description: 'Read the source code of a wrapper module',
    inputSchema: { type: 'object', properties: { specifier: { type: 'string' } }, required: ['specifier'] },
  },
  {
    name: 'execute_code',
    description: 'Execute user code that can import and call downstream MCP tools',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, timeoutMs: { type: 'number' } },
      required: ['code'],
    },
  },
];

export type ContextComparison = {
  vanilla: { toolCount: number; schemaTokens: number; schemaJson: string };
  whitenoise: { toolCount: number; schemaTokens: number; schemaJson: string };
};

type CatalogLike = { listAll: () => Array<{ tool: string; fqTool: string; description?: string; inputSchemaRaw?: unknown }> };

export async function getContextComparison(catalog: CatalogLike): Promise<ContextComparison> {
  const entries = catalog.listAll();
  const vanillaTools = entries.map((e) => ({
    name: e.fqTool,
    description: e.description ?? '',
    inputSchema: e.inputSchemaRaw ?? {},
  }));
  const vanillaJson = JSON.stringify(vanillaTools, null, 2);
  const whitenoiseJson = JSON.stringify(META_TOOL_SCHEMAS, null, 2);

  return {
    vanilla: {
      toolCount: vanillaTools.length,
      schemaTokens: estimateTokens(vanillaJson),
      schemaJson: vanillaJson,
    },
    whitenoise: {
      toolCount: META_TOOL_SCHEMAS.length,
      schemaTokens: estimateTokens(whitenoiseJson),
      schemaJson: whitenoiseJson,
    },
  };
}
