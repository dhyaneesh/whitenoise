// src/downstream/names.ts

/**
 * CamelCase a tool name for wrapper file/module specifier.
 * Example: list_directory → listDirectory
 */
export function toCamelCase(name: string): string {
  return name
    .split(/[_-]/)
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join('');
}

/**
 * Build the wrapper module specifier for read_module / execute_code imports.
 * Must match wrappers directory layout: mcp/servers/<server>/<camelCaseTool>
 */
export function makeSpecifier(server: string, tool: string): string {
  return `mcp/servers/${server}/${toCamelCase(tool)}`;
}

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

