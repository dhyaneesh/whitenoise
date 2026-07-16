import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ToolCatalog, CatalogEntry } from '../downstream/catalog.js';
import { jsonSchemaToSource } from '../downstream/schemaConverter.js';
import { toCamelCase } from '../downstream/names.js';

function toPascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function jsDocBlock(description?: string): string {
  if (!description) return '';
  const lines = description.trim().split(/\r?\n/);
  if (lines.length === 1) {
    return `/** ${lines[0]} */\n`;
  }
  return `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */\n`;
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

  // 2. Per-tool wrappers (sorted for deterministic output) — write in parallel
  const entries = catalog.listAll().sort((a, b) =>
    a.fqTool.localeCompare(b.fqTool)
  );

  // Pre-create server dirs so parallel writes don't race on mkdir
  const servers = [...new Set(entries.map((e) => e.server))];
  await Promise.all(
    servers.map((server) =>
      mkdir(path.join(wrappersDir, 'servers', server), { recursive: true })
    )
  );

  await Promise.all(entries.map((entry) => writeToolWrapper(wrappersDir, entry)));
}

async function writeToolWrapper(
  wrappersDir: string,
  entry: CatalogEntry
): Promise<void> {
  const toolFn = toCamelCase(entry.tool);
  const schemaName = toPascalCase(entry.tool) + 'Schema';
  const pascal = toPascalCase(entry.tool);

  const serverDir = path.join(wrappersDir, 'servers', entry.server);

  // Generate schema file from raw JSON Schema (preserves descriptions/defaults)
  const schemaFilePath = path.join(serverDir, `${toolFn}.schema.ts`);
  const schemaSourceCode = entry.inputSchemaRaw
    ? jsonSchemaToSource(entry.inputSchemaRaw)
    : 'z.unknown()';

  const schemaSource = `import { z } from 'zod';

export const ${schemaName} = ${schemaSourceCode};
`;

  // Generate typed wrapper file with JSDoc from tool description
  const wrapperFilePath = path.join(serverDir, `${toolFn}.ts`);
  const doc = jsDocBlock(entry.description);

  const wrapperSource = `import { callMCPTool } from 'mcp/bridge/callMCPTool';
import type { z } from 'zod';
import { ${schemaName} } from './${toolFn}.schema';
import type { MCPResult } from 'mcp/bridge/callMCPTool';

export type ${pascal}Input = z.infer<typeof ${schemaName}>;
export type ${pascal}Output = MCPResult;

${doc}export async function ${toolFn}(
  input: ${pascal}Input
): Promise<${pascal}Output> {
  return callMCPTool('${entry.fqTool}', input);
}
`;

  await Promise.all([
    writeFile(schemaFilePath, schemaSource, 'utf8'),
    writeFile(wrapperFilePath, wrapperSource, 'utf8'),
  ]);
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
