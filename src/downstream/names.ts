// src/downstream/names.ts

/**
 * Build a fully-qualified tool name.
 * Example: slack + post_message → slack__post_message
 */
export function makeFqTool(server: string, tool: string): string {
  return `${server}__${tool}`;
}

/**
 * Parse a fully-qualified tool name.
 * Example: slack__post_message → { server: 'slack', tool: 'post_message' }
 */
export function parseFqTool(fqTool: string): { server: string; tool: string } {
  const idx = fqTool.indexOf('__');
  if (idx === -1) {
    throw new Error(`Invalid fqTool: ${fqTool}`);
  }
  return {
    server: fqTool.slice(0, idx),
    tool: fqTool.slice(idx + 2)
  };
}

