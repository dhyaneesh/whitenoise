import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const whiteNoiseRoot = path.resolve(__dirname, '../..');
process.chdir(whiteNoiseRoot);

const dist = path.join(whiteNoiseRoot, 'dist');

async function loadWhiteNoise() {
  const poolModule = await import(pathToFileURL(path.join(dist, 'downstream/pool.js')).href);
  const catalogModule = await import(pathToFileURL(path.join(dist, 'downstream/catalog.js')).href);
  const wrappersModule = await import(pathToFileURL(path.join(dist, 'wrappers/manager.js')).href);
  const execModule = await import(pathToFileURL(path.join(dist, 'exec/manager.js')).href);

  const DownstreamPool = poolModule.DownstreamPool;
  const ToolCatalog = catalogModule.ToolCatalog;
  const prepareWrappers = wrappersModule.prepareWrappers;
  const wrappersDir = wrappersModule.wrappersDir;
  const ExecutionManager = execModule.ExecutionManager;

  const pool = new DownstreamPool();
  await pool.startAll();

  const catalog = new ToolCatalog(pool);
  await catalog.refresh();

  await prepareWrappers(catalog);

  const execMgr = new ExecutionManager(pool, wrappersDir);

  const modulesModule = await import(pathToFileURL(path.join(dist, 'wrappers/modules.js')).href);
  const listModules = modulesModule.listModules as (path?: string) => Promise<string[]>;
  const readModule = modulesModule.readModule as (specifier: string) => Promise<string>;

  return { pool, catalog, execMgr, listModules, readModule };
}

async function main() {
  const { pool, catalog, execMgr, listModules, readModule } = await loadWhiteNoise();
  const modules = { listModules, readModule };

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/benchmark/scenarios', async (_req, res) => {
    const { getScenarios } = await import('./scenarios.js');
    res.json(getScenarios());
  });

  app.get('/api/benchmark/context', async (_req, res) => {
    try {
      const { getContextComparison } = await import('./tokenCounter.js');
      const data = await getContextComparison(catalog);
      res.json(data);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/benchmark/run', async (req, res) => {
    try {
      const { scenarioId } = req.body as { scenarioId?: string };
      if (!scenarioId) {
        res.status(400).json({ error: 'scenarioId required' });
        return;
      }
      const { runScenario } = await import('./benchmark.js');
      const result = await runScenario(pool, execMgr, scenarioId);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/benchmark/run-all', async (_req, res) => {
    try {
      const { getScenarios } = await import('./scenarios.js');
      const { runScenario } = await import('./benchmark.js');
      const scenarios = getScenarios();
      const results: unknown[] = [];
      for (const s of scenarios) {
        const result = await runScenario(pool, execMgr, s.id);
        results.push({ scenarioId: s.id, ...result });
      }
      res.json(results);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/llm/run-vanilla', async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.status(500).json({ error: 'OPENAI_API_KEY not set' });
        return;
      }
      const { task, model } = req.body as { task?: string; model?: string };
      if (!task || typeof task !== 'string') {
        res.status(400).json({ error: 'task (string) required' });
        return;
      }
      const { runVanilla } = await import('./llmRun.js');
      const result = await runVanilla(task, pool, catalog, apiKey, model);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/llm/run-whitenoise', async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.status(500).json({ error: 'OPENAI_API_KEY not set' });
        return;
      }
      const { task, model } = req.body as { task?: string; model?: string };
      if (!task || typeof task !== 'string') {
        res.status(400).json({ error: 'task (string) required' });
        return;
      }
      const { runWhiteNoise } = await import('./llmRun.js');
      const result = await runWhiteNoise(task, pool, catalog, execMgr, modules, apiKey, model);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const PORT = 3001;
  app.listen(PORT, () => {
    console.error(`[dashboard] API server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[dashboard] fatal error', err);
  process.exit(1);
});
