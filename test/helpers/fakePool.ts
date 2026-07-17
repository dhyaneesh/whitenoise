import type { FakeTool } from './fixtures.js';
import { filesystemTools, memoryTools } from './fixtures.js';

type CallToolArgs = {
  name: string;
  arguments?: Record<string, unknown>;
};

type FakeClient = {
  callTool: (args: CallToolArgs) => Promise<unknown>;
};

export type FakePoolOptions = {
  /** Map of server name -> tools. Defaults to filesystem + memory fixtures. */
  toolsByServer?: Record<string, FakeTool[]>;
  /** Servers whose listTools should reject */
  failingServers?: string[];
  /** Optional callTool implementation (shared across clients) */
  callTool?: (args: CallToolArgs) => Promise<unknown>;
};

/**
 * Minimal DownstreamPool stand-in for unit/integration tests.
 * Satisfies the methods ToolCatalog and ExecutionManager actually call.
 */
export function createFakePool(options: FakePoolOptions = {}) {
  const toolsByServer: Record<string, FakeTool[]> = options.toolsByServer ?? {
    filesystem: filesystemTools,
    memory: memoryTools,
  };
  const failing = new Set(options.failingServers ?? []);

  const defaultCallTool = async (args: CallToolArgs) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, tool: args.name, args: args.arguments }),
      },
    ],
  });

  const callToolImpl = options.callTool ?? defaultCallTool;

  const clients = new Map<string, FakeClient>();
  for (const name of Object.keys(toolsByServer)) {
    clients.set(name, {
      callTool: callToolImpl,
    });
  }

  return {
    getServerNames(): string[] {
      return Object.keys(toolsByServer);
    },

    async listTools(serverName: string) {
      if (failing.has(serverName)) {
        throw new Error(`listTools failed for ${serverName}`);
      }
      const tools = toolsByServer[serverName];
      if (!tools) {
        throw new Error(`Unknown server: ${serverName}`);
      }
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },

    getClient(name: string): FakeClient {
      const client = clients.get(name);
      if (!client) {
        const err = new Error(`Downstream server not connected: ${name}`);
        err.name = 'DownstreamUnavailableError';
        throw err;
      }
      return client;
    },
  };
}

export type FakePool = ReturnType<typeof createFakePool>;
