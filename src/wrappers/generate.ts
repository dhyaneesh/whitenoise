import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ToolCatalog, CatalogEntry } from '../downstream/catalog.js';
import { zodToSource } from '../downstream/schemaConverter.js';

function toCamelCase(name: string): string {
  return name
    .split(/[_-]/)
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join('');
}

function toPascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export async function generateWrappers(
  wrappersDir: string,
  catalog: ToolCatalog
): Promise<void> {
  // 1. Bridge module
  const bridgeDir = path.join(wrappersDir, 'bridge');
  await mkdir(bridgeDir, { recursive: true });

  await writeFile(
    path.join(bridgeDir, 'callMCPTool.ts'),
    BRIDGE_SOURCE,
    'utf8'
  );

  // 2. Per-tool wrappers (sorted for deterministic output)
  for (const entry of catalog.listAll().sort((a, b) =>
    a.fqTool.localeCompare(b.fqTool)
  )) {
    await writeToolWrapper(wrappersDir, entry);
  }
}

async function writeToolWrapper(
  wrappersDir: string,
  entry: CatalogEntry
): Promise<void> {
  const toolFn = toCamelCase(entry.tool);
  const schemaName = toPascalCase(entry.tool) + 'Schema';

  const serverDir = path.join(wrappersDir, 'servers', entry.server);
  await mkdir(serverDir, { recursive: true });

  // Generate schema file
  const schemaFilePath = path.join(serverDir, `${toolFn}.schema.ts`);
  const schemaSourceCode = entry.inputSchema
    ? zodToSource(entry.inputSchema)
    : 'z.unknown()';

  const schemaSource = `import { z } from 'zod';

export const ${schemaName} = ${schemaSourceCode};
`;

  await writeFile(schemaFilePath, schemaSource, 'utf8');

  // Generate typed wrapper file
  const wrapperFilePath = path.join(serverDir, `${toolFn}.ts`);

  const wrapperSource = `import { callMCPTool } from 'mcp/bridge/callMCPTool';
import type { z } from 'zod';
import { ${schemaName} } from './${toolFn}.schema';
import type { MCPResult } from 'mcp/bridge/callMCPTool';

export type ${toPascalCase(entry.tool)}Input = z.infer<typeof ${schemaName}>;
export type ${toPascalCase(entry.tool)}Output = MCPResult;

export async function ${toolFn}(
  input: ${toPascalCase(entry.tool)}Input
): Promise<${toPascalCase(entry.tool)}Output> {
  return callMCPTool('${entry.fqTool}', input);
}
`;

  await writeFile(wrapperFilePath, wrapperSource, 'utf8');
}

const BRIDGE_SOURCE = `/**
 * Bridge module - calls into Worker's globalThis.__callMCPTool
 */
export type { MCPResult, MCPSuccess, MCPError } from '../../proxy/runtimeSchemas';
import type { MCPResult } from '../../proxy/runtimeSchemas';

export async function callMCPTool(fqTool: string, args: unknown): Promise<MCPResult> {
  return (globalThis as any).__callMCPTool(fqTool, args);
}
`;
