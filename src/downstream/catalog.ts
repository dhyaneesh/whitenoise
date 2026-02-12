// src/downstream/catalog.ts

import type { z } from 'zod';
import type { DownstreamPool } from './pool.js';
import { makeFqTool } from './names.js';
import { jsonSchemaToZod } from './schemaConverter.js';
import { MCPResultSchema } from '../proxy/runtimeSchemas.js';

export type CatalogEntry = {
  server: string;
  tool: string;
  fqTool: string;
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
    const q = query.toLowerCase();

    return this.entries
      .map(entry => ({
        entry,
        score: scoreEntry(entry, q)
      }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.entry);
  }
}

/**
 * Simple deterministic scoring.
 */
function scoreEntry(entry: CatalogEntry, q: string): number {
  let score = 0;

  if (entry.tool.toLowerCase().includes(q)) score += 3;
  if (entry.fqTool.toLowerCase().includes(q)) score += 2;
  if (entry.description?.toLowerCase().includes(q)) score += 1;

  return score;
}

