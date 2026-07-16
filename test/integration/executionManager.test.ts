import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakePool } from '../helpers/fakePool.js';
import { makeTempDir, removeTempDir } from '../helpers/tempDir.js';
import type { DownstreamPool } from '../../src/downstream/pool.js';

type ExecResult = { durationMs: number; stdout: string; stderr: string };

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
  const execUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/exec/manager.js')
  ).href;

  const [{ ToolCatalog }, { generateWrappers }, exec] = await Promise.all([
    import(catalogUrl),
    import(generateUrl),
    import(execUrl),
  ]);

  return {
    ToolCatalog,
    generateWrappers,
    ExecutionManager: exec.ExecutionManager as new (
      pool: DownstreamPool,
      wrappersDir: string,
      options?: { poolSize?: number; maxRunsPerWorker?: number }
    ) => ExecutionManagerLike,
    ExecutionTimeoutError: exec.ExecutionTimeoutError as new (
      runId: string
    ) => Error,
    QueueFullError: exec.QueueFullError as new () => Error,
  };
}

describe('ExecutionManager', () => {
  let dist: Awaited<ReturnType<typeof loadDist>>;
  let wrappersDir: string;
  let mgr: ExecutionManagerLike | null = null;

  beforeAll(async () => {
    dist = await loadDist();
    wrappersDir = await makeTempDir('wn-exec-wrap-');

    const pool = createFakePool();
    const catalog = new dist.ToolCatalog(pool as unknown as DownstreamPool);
    await catalog.refresh();
    await dist.generateWrappers(wrappersDir, catalog);
  });

  afterAll(async () => {
    await removeTempDir(wrappersDir);
  });

  afterEach(async () => {
    if (mgr) {
      await mgr.shutdown().catch(() => {});
      mgr = null;
    }
  });

  function createMgr(
    poolOpts?: Parameters<typeof createFakePool>[0],
    execOpts?: { poolSize?: number; maxRunsPerWorker?: number }
  ) {
    const pool = createFakePool(poolOpts);
    mgr = new dist.ExecutionManager(
      pool as unknown as DownstreamPool,
      wrappersDir,
      { poolSize: 1, ...execOpts }
    );
    return { mgr, pool };
  }

  it('captures stdout from a smoke script', async () => {
    const { mgr: m } = createMgr();
    const result = await m.execute(`console.log('smoke-test-ok');`, {
      timeoutMs: 10_000,
    });
    expect(result.stdout).toContain('smoke-test-ok');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('routes wrapper tool calls through the downstream client', async () => {
    let called: { name: string; arguments?: Record<string, unknown> } | null =
      null;

    const { mgr: m } = createMgr({
      callTool: async (args) => {
        called = args;
        return {
          content: [{ type: 'text', text: 'file-contents-here' }],
        };
      },
    });

    const code = `
import { readFile } from 'mcp/servers/filesystem/readFile';
const result = await readFile({ path: '/tmp/example.txt' });
console.log(JSON.stringify(result));
`;
    const result = await m.execute(code, { timeoutMs: 15_000 });
    expect(called?.name).toBe('read_file');
    expect(called?.arguments).toEqual({ path: '/tmp/example.txt' });
    expect(result.stdout).toContain('file-contents-here');
  });

  it('rejects invalid TypeScript', async () => {
    const { mgr: m } = createMgr();
    await expect(
      m.execute('const broken = ;', { timeoutMs: 10_000 })
    ).rejects.toThrow();
  });

  it('rejects runtime exceptions with the message', async () => {
    const { mgr: m } = createMgr();
    await expect(
      m.execute(`throw new Error('expected test error');`, {
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/expected test error/);
  });

  it('times out hanging scripts and recovers for later jobs', async () => {
    const { mgr: m } = createMgr();

    await expect(
      m.execute(`await new Promise(() => {});`, { timeoutMs: 500 })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof dist.ExecutionTimeoutError ||
        (err instanceof Error && /timed out/i.test(err.message))
    );

    const result = await m.execute(`console.log('after-timeout');`, {
      timeoutMs: 10_000,
    });
    expect(result.stdout).toContain('after-timeout');
  });

  it('throws QueueFullError when the queue is saturated', async () => {
    const { mgr: m } = createMgr(undefined, { poolSize: 1 });

    const hang = `await new Promise(() => {});`;
    // One active + fill the 50-deep queue
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 51; i++) {
      pending.push(
        m.execute(hang, { timeoutMs: 60_000 }).catch((err) => err)
      );
    }

    await expect(
      m.execute(hang, { timeoutMs: 60_000 })
    ).rejects.toBeInstanceOf(dist.QueueFullError);

    // Shutdown cleans up hanging jobs
    await m.shutdown();
    mgr = null;
    await Promise.all(pending);
  });

  it('recycles a worker after maxRunsPerWorker', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { mgr: m } = createMgr(undefined, {
      poolSize: 1,
      maxRunsPerWorker: 2,
    });

    await m.execute(`console.log('run-1');`, { timeoutMs: 10_000 });
    await m.execute(`console.log('run-2');`, { timeoutMs: 10_000 });
    const third = await m.execute(`console.log('run-3');`, {
      timeoutMs: 10_000,
    });
    expect(third.stdout).toContain('run-3');

    const recycled = spy.mock.calls.some((args) =>
      String(args[0]).includes('recycling worker')
    );
    spy.mockRestore();
    expect(recycled).toBe(true);
  });

  it('shutdown rejects active and queued jobs', async () => {
    const { mgr: m } = createMgr(undefined, { poolSize: 1 });

    const hang = `await new Promise(() => {});`;
    const active = m.execute(hang, { timeoutMs: 60_000 });
    // Let the active run start
    await new Promise((r) => setTimeout(r, 100));
    const queued = m.execute(hang, { timeoutMs: 60_000 });

    // Attach rejection handlers before shutdown so rejections are not unhandled
    const activeExpect = expect(active).rejects.toThrow(/shutting down/i);
    const queuedExpect = expect(queued).rejects.toThrow(/shutting down/i);

    await m.shutdown();
    mgr = null;

    await Promise.all([activeExpect, queuedExpect]);
  });
});
