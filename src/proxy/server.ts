// src/proxy/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SearchToolsInput,
  ListModulesInput,
  ReadModuleInput,
  ExecuteCodeInput,
} from './toolSchemas.js';

import type { ToolCatalog } from '../downstream/catalog.js';
import type { ExecutionManager } from '../exec/manager.js';
import { listModules, readModule } from '../wrappers/modules.js';
import {
  ATTR,
  byteLength,
  countMcpImports,
  lineCount,
  sha256Hex,
} from '../telemetry/attributes.js';
import { modelFacingErrorPayload } from '../telemetry/errors.js';
import {
  recordDiscoveryBytes,
  recordError,
  recordModuleRead,
  recordSearchDuration,
  recordSearchZeroMatch,
} from '../telemetry/metrics.js';
import { withSpan } from '../telemetry/tracing.js';

export function createProxyServer(
  catalog: ToolCatalog,
  execMgr: ExecutionManager
): McpServer {
  const server = new McpServer({
    name: 'meta-mcp-proxy',
    version: '0.1.0',
  });

  // ---- search_tools ----
  server.tool(
    'search_tools',
    'Search the downstream tool catalog by name or description. Each result includes a specifier you can pass to read_module to get the wrapper source.',
    SearchToolsInput.shape,
    async ({ query, limit }) => {
      return withSpan(
        'mcp.server search_tools',
        {
          [ATTR.MCP_METHOD_NAME]: 'tools/call',
          [ATTR.GEN_AI_TOOL_NAME]: 'search_tools',
          [ATTR.META_TOOL_NAME]: 'search_tools',
        },
        async (span) => {
          try {
            const started = Date.now();
            const detailed = catalog.searchDetailed(query, limit);
            const durationMs = Date.now() - started;

            const words = query
              .trim()
              .toLowerCase()
              .split(/[^a-z0-9]+/i)
              .filter(Boolean);

            span.setAttribute(ATTR.SEARCH_QUERY_LENGTH, query.length);
            span.setAttribute(ATTR.SEARCH_QUERY_WORD_COUNT, words.length);
            span.setAttribute(ATTR.SEARCH_LIMIT, limit ?? 20);
            span.setAttribute(
              ATTR.SEARCH_RESULT_COUNT,
              detailed.results.length
            );
            span.setAttribute(ATTR.SEARCH_TOP_SCORE, detailed.topScore);
            span.setAttribute(ATTR.SEARCH_ZERO_MATCH, detailed.zeroMatch);
            span.setAttribute(
              ATTR.SEARCH_FALLBACK_USED,
              detailed.fallbackUsed
            );

            recordSearchDuration(durationMs, detailed.fallbackUsed);
            if (detailed.zeroMatch) recordSearchZeroMatch();

            const text = JSON.stringify(
              {
                query,
                count: detailed.results.length,
                results: detailed.results,
                fallbackUsed: detailed.fallbackUsed,
                zeroMatch: detailed.zeroMatch,
              },
              null,
              2
            );
            const bytes = byteLength(text);
            span.setAttribute(ATTR.RESPONSE_BYTES, bytes);
            recordDiscoveryBytes(bytes, 'search_tools');

            return {
              content: [{ type: 'text', text }],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: err.message }],
            };
          }
        }
      );
    }
  );

  // ---- list_modules ----
  server.tool(
    'list_modules',
    'List wrapper module specifiers. Use when search_tools does not find what you need (fallback for full context).',
    ListModulesInput.shape,
    async ({ path }) => {
      return withSpan(
        'mcp.server list_modules',
        {
          [ATTR.MCP_METHOD_NAME]: 'tools/call',
          [ATTR.GEN_AI_TOOL_NAME]: 'list_modules',
          [ATTR.META_TOOL_NAME]: 'list_modules',
        },
        async (span) => {
          try {
            const modules = await listModules(path);
            const text = JSON.stringify(modules, null, 2);
            span.setAttribute(ATTR.RESPONSE_BYTES, byteLength(text));
            recordDiscoveryBytes(byteLength(text), 'list_modules');
            return {
              content: [{ type: 'text', text }],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: err.message }],
            };
          }
        }
      );
    }
  );

  // ---- read_module ----
  server.tool(
    'read_module',
    'Return the source code of a wrapper module. Use the specifier from search_tools results (or from list_modules).',
    ReadModuleInput.shape,
    async ({ specifier }) => {
      return withSpan(
        'mcp.server read_module',
        {
          [ATTR.MCP_METHOD_NAME]: 'tools/call',
          [ATTR.GEN_AI_TOOL_NAME]: 'read_module',
          [ATTR.META_TOOL_NAME]: 'read_module',
          [ATTR.MODULE_SPECIFIER]: specifier,
        },
        async (span) => {
          try {
            const source = await readModule(specifier);
            const bytes = byteLength(source);
            span.setAttribute(ATTR.MODULE_SOURCE_BYTES, bytes);
            span.setAttribute(ATTR.RESPONSE_BYTES, bytes);
            recordDiscoveryBytes(bytes, 'read_module');
            recordModuleRead();
            return {
              content: [{ type: 'text', text: source }],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: 'text', text: err.message }],
            };
          }
        }
      );
    }
  );

  // ---- execute_code ----
  server.tool(
    'execute_code',
    'Execute user code that can import and call downstream MCP tools',
    ExecuteCodeInput.shape,
    async ({ code, timeoutMs }) => {
      return withSpan(
        'mcp.server execute_code',
        {
          [ATTR.MCP_METHOD_NAME]: 'tools/call',
          [ATTR.GEN_AI_TOOL_NAME]: 'execute_code',
          [ATTR.META_TOOL_NAME]: 'execute_code',
          [ATTR.REQUEST_TIMEOUT_MS]: timeoutMs ?? 30_000,
        },
        async (span) => {
          const imports = countMcpImports(code);
          span.setAttribute(ATTR.CODE_BYTES, byteLength(code));
          span.setAttribute(ATTR.CODE_SHA256, sha256Hex(code));
          span.setAttribute(ATTR.CODE_LINE_COUNT, lineCount(code));
          span.setAttribute(ATTR.CODE_IMPORT_COUNT, imports.importCount);
          span.setAttribute(
            ATTR.EXECUTION_IMPORT_COUNT,
            imports.importCount
          );
          span.setAttribute(
            ATTR.EXECUTION_IMPORTED_TOOL_COUNT,
            imports.toolCount
          );
          span.setAttribute(
            ATTR.EXECUTION_UNIQUE_SERVER_COUNT,
            imports.uniqueServers
          );

          try {
            const result = await execMgr.execute(code, { timeoutMs });
            const text = JSON.stringify(result, null, 2);
            span.setAttribute(ATTR.RESPONSE_BYTES, byteLength(text));
            span.setAttribute(
              ATTR.EXECUTION_DOWNSTREAM_CALL_COUNT,
              result.downstreamCallCount
            );
            span.setAttribute(
              ATTR.EXECUTION_ROUND_TRIPS_AVOIDED,
              Math.max(0, result.downstreamCallCount - 1)
            );
            span.setAttribute(ATTR.STDOUT_TRUNCATED, result.stdoutTruncated);
            span.setAttribute(ATTR.STDERR_TRUNCATED, result.stderrTruncated);
            return {
              content: [{ type: 'text', text }],
            };
          } catch (err: unknown) {
            const classified = modelFacingErrorPayload(err);
            span.setAttribute(ATTR.ERROR_TYPE, classified.type);
            recordError({ layer: 'proxy', type: classified.type });
            const text = JSON.stringify(classified, null, 2);
            span.setAttribute(ATTR.RESPONSE_BYTES, byteLength(text));
            return {
              isError: true,
              content: [{ type: 'text', text }],
            };
          }
        }
      );
    }
  );

  return server;
}
