// src/downstream/catalog.ts

import type { z } from 'zod';
import type { DownstreamPool } from './pool.js';
import { makeFqTool, makeSpecifier } from './names.js';
import { jsonSchemaToZod } from './schemaConverter.js';
import { MCPResultSchema } from '../proxy/runtimeSchemas.js';

export type CatalogEntry = {
  server: string;
  tool: string;
  fqTool: string;
  /** Module specifier for read_module, e.g. mcp/servers/filesystem/listDirectory */
  specifier: string;
  description?: string;
  inputSchema?: z.ZodTypeAny;
  inputSchemaRaw?: unknown;
  outputSchema?: z.ZodTypeAny;
};

export class ToolCatalog {
  private entries: CatalogEntry[] = [];

  constructor(private pool: DownstreamPool) {}

  /**
   * Refresh catalog by querying all downstream servers.
   * Call once at boot (or later if you add hot-reload).
   */
  async refresh(): Promise<void> {
    const all: CatalogEntry[] = [];

    // Reach into the pool's known servers
    const serverNames = this.pool.getServerNames();

    for (const server of serverNames) {
      const tools = await this.pool.listTools(server);

      for (const tool of tools) {
        const fqTool = makeFqTool(server, tool.name);

        // Validate fqTool integrity - fail fast on corruption
        if (!fqTool.includes('__')) {
          throw new Error(`Invalid fqTool generated: ${fqTool}`);
        }

        all.push({
          server,
          tool: tool.name,
          fqTool,
          specifier: makeSpecifier(server, tool.name),
          description: tool.description,
          inputSchema: jsonSchemaToZod(tool.inputSchema),
          inputSchemaRaw: tool.inputSchema,
          outputSchema: MCPResultSchema,
        });
      }
    }

    this.entries = all;
  }

  /**
   * Return all catalog entries.
   */
  listAll(): CatalogEntry[] {
    return [...this.entries];
  }

  /**
   * Search tools by name/description.
   */
  search(query: string, limit = 20): CatalogEntry[] {
    const trimmed = query.trim().toLowerCase();

    // Empty query: fall back to a deterministic "browse" listing.
    if (!trimmed) {
      return [...this.entries]
        .sort((a, b) => a.tool.localeCompare(b.tool) || a.fqTool.localeCompare(b.fqTool))
        .slice(0, limit);
    }

    // Tokenize query into words (whitespace + punctuation).
    const words = trimmed.split(/[^a-z0-9]+/i).filter(Boolean);

    const scored = this.entries.map((entry) => ({
      entry,
      score: scoreEntry(entry, words),
    }));

    const positive = scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.entry);

    if (positive.length > 0) return positive;

    // Empty-result fallback: if nothing scores above zero, return a
    // deterministic browse-style list so the caller can still discover tools.
    return [...this.entries]
      .sort((a, b) => a.tool.localeCompare(b.tool) || a.fqTool.localeCompare(b.fqTool))
      .slice(0, limit);
  }
}

/**
 * Simple deterministic scoring.
 */
function scoreEntry(entry: CatalogEntry, words: string[]): number {
  let score = 0;

  if (words.length === 0) return score;

  const tool = entry.tool.toLowerCase();
  const fqTool = entry.fqTool.toLowerCase();
  const desc = entry.description?.toLowerCase() ?? '';

  for (const w of words) {
    if (!w) continue;
    if (tool.includes(w)) score += 3;
    if (fqTool.includes(w)) score += 2;
    if (desc.includes(w)) score += 1;
  }

  return score;
}

