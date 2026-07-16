import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProxyServer } from './proxy/server.js';
import { DownstreamPool } from './downstream/pool.js';
import { ToolCatalog } from './downstream/catalog.js';
import { prepareWrappers, regenerateWrappers, wrappersDir } from './wrappers/manager.js';
import { ExecutionManager } from './exec/manager.js';

/**
 * Serialize async work so concurrent triggers collapse into at most one
 * in-flight run plus one queued follow-up (latest-wins).
 */
function createSingleFlight(label: string) {
  let inflight: Promise<void> | null = null;
  let pending = false;

  return (work: () => Promise<void>) => {
    if (inflight) {
      pending = true;
      return;
    }

    const run = async () => {
      do {
        pending = false;
        try {
          await work();
        } catch (err) {
          console.error(`[proxy] ${label} failed:`, err);
        }
      } while (pending);
      inflight = null;
    };

    inflight = run();
  };
}

function installShutdownHandlers(cleanup: () => Promise<void>) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('[proxy] shutting down:', signal);
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Contain stray errors — do not take down the whole proxy
  process.on('uncaughtException', (err) => {
    console.error('[proxy] uncaughtException (contained):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[proxy] unhandledRejection (contained):', reason);
  });
}

async function main() {
  console.error('[proxy] booting');

  const pool = new DownstreamPool();
  await pool.startAll();
  console.error('[proxy] downstream servers connected');

  const catalog = new ToolCatalog(pool);
  await catalog.refresh();

  await prepareWrappers(catalog);

  const refreshCatalogAndWrappers = createSingleFlight('catalog refresh');

  // Hot reload: refresh catalog and wrappers when downstream servers change
  pool.onChange(() => {
    console.error('[proxy] downstream change detected, refreshing catalog');
    refreshCatalogAndWrappers(async () => {
      await catalog.refresh();
      await regenerateWrappers(catalog);
      console.error('[proxy] catalog and wrappers refreshed');
    });
  });

  const execMgr = new ExecutionManager(pool, wrappersDir);
  const server = createProxyServer(catalog, execMgr);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  async function cleanup() {
    await execMgr.shutdown();
    await pool.stopAll();
  }

  installShutdownHandlers(cleanup);

  console.error('[proxy] MCP proxy server ready');
}

main().catch((err) => {
  console.error('[proxy] fatal error', err);
  process.exit(1);
});
