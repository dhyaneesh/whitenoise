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
    'Search the downstream tool catalog by name or description',
    SearchToolsInput.shape,
    async ({ query, limit }) => {
      try {
        const results = catalog.search(query, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { query, count: results.length, results },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: err.message }],
        };
      }
    }
  );

  // ---- list_modules ----
  server.tool(
    'list_modules',
    'List all generated wrapper modules for downstream tools',
    ListModulesInput.shape,
    async ({ path }) => {
      try {
        const modules = await listModules(path);
        return {
          content: [{ type: 'text', text: JSON.stringify(modules, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: err.message }],
        };
      }
    }
  );

  // ---- read_module ----
  server.tool(
    'read_module',
    'Read the source code of a wrapper module',
    ReadModuleInput.shape,
    async ({ specifier }) => {
      try {
        const source = await readModule(specifier);
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

  // ---- execute_code ----
  server.tool(
    'execute_code',
    'Execute user code that can import and call downstream MCP tools',
    ExecuteCodeInput.shape,
    async ({ code, timeoutMs }) => {
      try {
        const result = await execMgr.execute(code, { timeoutMs });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        // Return as normal content - LLM should fix their code, not retry
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { error: err.message, stack: err.stack },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  return server;
}
