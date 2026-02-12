import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProxyServer } from './proxy/server.js';
import { DownstreamPool } from './downstream/pool.js';
import { ToolCatalog } from './downstream/catalog.js';
import { prepareWrappers, regenerateWrappers, wrappersDir } from './wrappers/manager.js';
import { ExecutionManager } from './exec/manager.js';

function installShutdownHandlers(cleanup: () => Promise<void>) {
  const shutdown = async (signal: string, err?: unknown) => {
    console.error('[proxy] shutting down:', signal);
    if (err) console.error(err);
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => shutdown('uncaughtException', err));
  process.on('unhandledRejection', (err) => shutdown('unhandledRejection', err));
}

async function main() {
  console.error('[proxy] booting');

  const pool = new DownstreamPool();
  await pool.startAll();
  console.error('[proxy] all downstream servers connected');

  const catalog = new ToolCatalog(pool);
  await catalog.refresh();

  await prepareWrappers(catalog);

  // Hot reload: refresh catalog and wrappers when downstream servers change
  pool.onChange(async () => {
    console.error('[proxy] downstream change detected, refreshing catalog');
    try {
      await catalog.refresh();
      await regenerateWrappers(catalog);
      console.error('[proxy] catalog and wrappers refreshed');
    } catch (err) {
      console.error('[proxy] refresh failed:', err);
    }
  });

  const execMgr = new ExecutionManager(pool, wrappersDir);
  const server = createProxyServer(catalog, execMgr);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Install shutdown handlers with cleanup
  async function cleanup() {
    await execMgr?.shutdown();
    await pool?.stopAll();
  }

  installShutdownHandlers(cleanup);

  console.error('[proxy] MCP proxy server ready');
}

main().catch((err) => {
  console.error('[proxy] fatal error', err);
  process.exit(1);
});
