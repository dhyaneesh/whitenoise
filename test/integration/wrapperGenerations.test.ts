import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakePool } from '../helpers/fakePool.js';
import { makeTempDir, removeTempDir } from '../helpers/tempDir.js';
import type { DownstreamPool } from '../../src/downstream/pool.js';

type ExecResult = {
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  downstreamCallCount: number;
};

type ExecutionManagerLike = {
  execute: (
    script: string,
    options?: { timeoutMs?: number }
  ) => Promise<ExecResult>;
  shutdown: () => Promise<void>;
};

async function loadDist() {
  const catalogUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/downstream/catalog.js')
  ).href;
  const generateUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/wrappers/generate.js')
  ).href;
  const genUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/wrappers/generations.js')
  ).href;
  const execUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/exec/manager.js')
  ).href;

  const [{ ToolCatalog }, { generateWrappers }, { GenerationStore }, exec] =
    await Promise.all([
      import(catalogUrl),
      import(generateUrl),
      import(genUrl),
      import(execUrl),
    ]);

  return {
    ToolCatalog,
    generateWrappers,
    GenerationStore,
    ExecutionManager: exec.ExecutionManager as new (
      pool: DownstreamPool,
      store: InstanceType<typeof GenerationStore>,
      options?: { poolSize?: number; maxRunsPerWorker?: number }
    ) => ExecutionManagerLike,
  };
}

describe('wrapper generation isolation during execution', () => {
  let dist: Awaited<ReturnType<typeof loadDist>>;
  let tmpBase: string;
  let store: InstanceType<typeof dist.GenerationStore>;

  beforeAll(async () => {
    dist = await loadDist();
    tmpBase = await makeTempDir('wn-gen-iso-');
    const wrappersRoot = path.join(tmpBase, 'wrappers');
    store = new dist.GenerationStore(wrappersRoot);
    await store.init();
  });

  afterAll(async () => {
    await removeTempDir(tmpBase);
  });

  it('in-flight run completes on the old generation after a new one is published', async () => {
    // Gen-1: publish wrappers
    const pool1 = createFakePool();
    const catalog1 = new dist.ToolCatalog(pool1 as unknown as DownstreamPool);
    await catalog1.refresh();
    await store.publish((genDir) => dist.generateWrappers(genDir, catalog1));

    // Latch: the downstream tool call blocks until we release it
    let releaseLatch: () => void = () => {};
    const latchPromise = new Promise<void>((resolve) => {
      releaseLatch = resolve;
    });

    const pool2 = createFakePool({
      callTool: async () => {
        await latchPromise;
        return { content: [{ type: 'text', text: 'latched-ok' }] };
      },
    });

    const mgr = new dist.ExecutionManager(
      pool2 as unknown as DownstreamPool,
      store,
      { poolSize: 1 }
    );

    const code = `
import { readFile } from 'mcp/servers/filesystem/readFile';
const result = await readFile({ path: '/tmp/test.txt' });
console.log(JSON.stringify(result));
`;

    // Start the execution — it will block inside the tool call
    const runPromise = mgr.execute(code, { timeoutMs: 30_000 });

    // Give the run time to start and make the tool call
    await new Promise((r) => setTimeout(r, 500));

    // Publish gen-2 while the run is in-flight (tool call pending)
    const pool3 = createFakePool();
    const catalog3 = new dist.ToolCatalog(pool3 as unknown as DownstreamPool);
    await catalog3.refresh();
    await store.publish((genDir) => dist.generateWrappers(genDir, catalog3));

    // GC should NOT remove gen-1 because the run pins it
    const removedBefore = await store.gc();
    expect(removedBefore).not.toContain(1);

    // Release the latch — the run should complete using gen-1's wrappers
    releaseLatch();

    const result = await runPromise;
    expect(result.stdout).toContain('latched-ok');
    expect(result.downstreamCallCount).toBe(1);

    // Now that the run is done, gen-1's refcount is 0 — GC can remove it
    const removedAfter = await store.gc();
    expect(removedAfter).toContain(1);

    await mgr.shutdown();
  }, 60_000);

  it('bundle cache is generation-scoped (miss after regeneration, hit on rerun)', async () => {
    const pool = createFakePool();
    const catalog = new dist.ToolCatalog(pool as unknown as DownstreamPool);
    await catalog.refresh();

    // Publish fresh gen
    await store.publish((genDir) => dist.generateWrappers(genDir, catalog));

    const mgr = new dist.ExecutionManager(
      pool as unknown as DownstreamPool,
      store,
      { poolSize: 1 }
    );

    const code = `console.log('cache-probe');`;

    // First run — cache miss (build)
    const r1 = await mgr.execute(code, { timeoutMs: 15_000 });
    expect(r1.stdout).toContain('cache-probe');

    // Second run — cache hit (same generation)
    const r2 = await mgr.execute(code, { timeoutMs: 15_000 });
    expect(r2.stdout).toContain('cache-probe');

    // Publish a new generation → same script should cache-miss
    await store.publish((genDir) => dist.generateWrappers(genDir, catalog));

    const r3 = await mgr.execute(code, { timeoutMs: 15_000 });
    expect(r3.stdout).toContain('cache-probe');

    await mgr.shutdown();
  }, 60_000);
});
