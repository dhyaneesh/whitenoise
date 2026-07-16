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

/** Internal entry with precomputed lowercase fields for search */
type IndexedEntry = CatalogEntry & {
  toolLower: string;
  fqToolLower: string;
  descLower: string;
};

export class ToolCatalog {
  private entries: IndexedEntry[] = [];
  /** Deterministic browse order — rebuilt on refresh */
  private browseOrder: IndexedEntry[] = [];

  constructor(private pool: DownstreamPool) {}

  /**
   * Refresh catalog by querying all downstream servers in parallel.
   * A single failing server is logged and skipped (does not abort the refresh).
   */
  async refresh(): Promise<void> {
    const serverNames = this.pool.getServerNames();

    const results = await Promise.allSettled(
      serverNames.map(async (server) => {
        const tools = await this.pool.listTools(server);
        return { server, tools };
      })
    );

    const all: IndexedEntry[] = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(
          '[catalog] listTools failed for a server:',
          result.reason
        );
        continue;
      }

      const { server, tools } = result.value;

      for (const tool of tools) {
        const fqTool = makeFqTool(server, tool.name);

        // Validate fqTool integrity - fail fast on corruption
        if (!fqTool.includes('__')) {
          throw new Error(`Invalid fqTool generated: ${fqTool}`);
        }

        const description = tool.description;
        all.push({
          server,
          tool: tool.name,
          fqTool,
          specifier: makeSpecifier(server, tool.name),
          description,
          inputSchema: jsonSchemaToZod(tool.inputSchema),
          inputSchemaRaw: tool.inputSchema,
          outputSchema: MCPResultSchema,
          toolLower: tool.name.toLowerCase(),
          fqToolLower: fqTool.toLowerCase(),
          descLower: description?.toLowerCase() ?? '',
        });
      }
    }

    this.entries = all;
    this.browseOrder = [...all].sort(
      (a, b) => a.tool.localeCompare(b.tool) || a.fqTool.localeCompare(b.fqTool)
    );
  }

  /**
   * Return all catalog entries (public fields only).
   */
  listAll(): CatalogEntry[] {
    return this.entries.map(toPublic);
  }

  /**
   * Search tools by name/description.
   */
  search(query: string, limit = 20): CatalogEntry[] {
    const trimmed = query.trim().toLowerCase();

    // Empty query: fall back to a deterministic "browse" listing.
    if (!trimmed) {
      return this.browseOrder.slice(0, limit).map(toPublic);
    }

    // Tokenize query into words (whitespace + punctuation).
    const words = trimmed.split(/[^a-z0-9]+/i).filter(Boolean);

    const scored: { entry: IndexedEntry; score: number }[] = [];
    for (const entry of this.entries) {
      const score = scoreEntry(entry, words);
      if (score > 0) scored.push({ entry, score });
    }

    if (scored.length === 0) {
      // Empty-result fallback: browse-style list so the caller can still discover tools.
      return this.browseOrder.slice(0, limit).map(toPublic);
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((r) => toPublic(r.entry));
  }
}

function toPublic(entry: IndexedEntry): CatalogEntry {
  return {
    server: entry.server,
    tool: entry.tool,
    fqTool: entry.fqTool,
    specifier: entry.specifier,
    description: entry.description,
    inputSchema: entry.inputSchema,
    inputSchemaRaw: entry.inputSchemaRaw,
    outputSchema: entry.outputSchema,
  };
}

/**
 * Simple deterministic scoring using precomputed lowercase fields.
 */
function scoreEntry(entry: IndexedEntry, words: string[]): number {
  if (words.length === 0) return 0;

  let score = 0;
  for (const w of words) {
    if (!w) continue;
    if (entry.toolLower.includes(w)) score += 3;
    if (entry.fqToolLower.includes(w)) score += 2;
    if (entry.descLower.includes(w)) score += 1;
  }

  return score;
}
