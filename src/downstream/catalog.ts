// src/downstream/catalog.ts

import type { z } from 'zod';
import type { DownstreamPool } from './pool.js';
import { makeFqTool, makeSpecifier } from './names.js';
import { jsonSchemaToZod } from './schemaConverter.js';
import { MCPResultSchema } from '../proxy/runtimeSchemas.js';
import { ATTR, byteLength } from '../telemetry/attributes.js';
import {
  recordCatalogFailedServers,
  recordCatalogRefreshDuration,
} from '../telemetry/metrics.js';
import { withSpan } from '../telemetry/tracing.js';

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

export type SearchResult = {
  results: CatalogEntry[];
  fallbackUsed: boolean;
  zeroMatch: boolean;
  topScore: number;
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
  private lastDefinitionBytes = 0;
  private lastFailedServers = 0;

  constructor(private pool: DownstreamPool) {}

  /**
   * Refresh catalog by querying all downstream servers in parallel.
   * A single failing server is logged and skipped (does not abort the refresh).
   */
  async refresh(): Promise<void> {
    const started = Date.now();
    await withSpan('whitenoise.catalog.refresh', undefined, async (span) => {
      const serverNames = this.pool.getServerNames();

      const results = await Promise.allSettled(
        serverNames.map(async (server) =>
          withSpan(
            `mcp.client tools/list [${server}]`,
            {
              [ATTR.MCP_METHOD_NAME]: 'tools/list',
              [ATTR.DOWNSTREAM_SERVER]: server,
            },
            async () => {
              const tools = await this.pool.listTools(server);
              return { server, tools };
            }
          )
        )
      );

      const all: IndexedEntry[] = [];
      let failedServers = 0;

      for (const result of results) {
        if (result.status === 'rejected') {
          failedServers += 1;
          console.error(
            '[catalog] listTools failed for a server:',
            result.reason
          );
          continue;
        }

        const { server, tools } = result.value;

        for (const tool of tools) {
          const fqTool = makeFqTool(server, tool.name);

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
        (a, b) =>
          a.tool.localeCompare(b.tool) || a.fqTool.localeCompare(b.fqTool)
      );
      this.lastFailedServers = failedServers;
      this.lastDefinitionBytes = computeDefinitionBytes(all);

      const partial = failedServers > 0;
      span.setAttribute(ATTR.CATALOG_TOOL_COUNT, all.length);
      span.setAttribute(ATTR.CATALOG_SERVER_COUNT, serverNames.length);
      span.setAttribute(ATTR.CATALOG_DEFINITION_BYTES, this.lastDefinitionBytes);
      span.setAttribute(ATTR.CATALOG_PARTIAL, partial);
      span.setAttribute(ATTR.CATALOG_FAILED_SERVERS, failedServers);

      recordCatalogFailedServers(failedServers);
    });

    recordCatalogRefreshDuration(Date.now() - started);
  }

  getDefinitionBytes(): number {
    return this.lastDefinitionBytes;
  }

  getLastFailedServers(): number {
    return this.lastFailedServers;
  }

  /**
   * Return all catalog entries (public fields only).
   */
  listAll(): CatalogEntry[] {
    return this.entries.map(toPublic);
  }

  /**
   * Search tools by name/description (convenience wrapper).
   */
  search(query: string, limit = 20): CatalogEntry[] {
    return this.searchDetailed(query, limit).results;
  }

  /**
   * Search with telemetry-friendly metadata (fallback / zero-match / top score).
   */
  searchDetailed(query: string, limit = 20): SearchResult {
    const trimmed = query.trim().toLowerCase();

    if (!trimmed) {
      return {
        results: this.browseOrder.slice(0, limit).map(toPublic),
        fallbackUsed: true,
        zeroMatch: false,
        topScore: 0,
      };
    }

    const words = trimmed.split(/[^a-z0-9]+/i).filter(Boolean);

    const scored: { entry: IndexedEntry; score: number }[] = [];
    for (const entry of this.entries) {
      const score = scoreEntry(entry, words);
      if (score > 0) scored.push({ entry, score });
    }

    if (scored.length === 0) {
      return {
        results: this.browseOrder.slice(0, limit).map(toPublic),
        fallbackUsed: true,
        zeroMatch: true,
        topScore: 0,
      };
    }

    scored.sort((a, b) => b.score - a.score);
    return {
      results: scored.slice(0, limit).map((r) => toPublic(r.entry)),
      fallbackUsed: false,
      zeroMatch: false,
      topScore: scored[0]?.score ?? 0,
    };
  }
}

function computeDefinitionBytes(entries: CatalogEntry[]): number {
  return byteLength(
    JSON.stringify(
      entries.map((entry) => ({
        name: entry.fqTool,
        description: entry.description,
        inputSchema: entry.inputSchemaRaw,
      }))
    )
  );
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
