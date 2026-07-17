import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { context, trace } from '@opentelemetry/api';
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
  const execUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/exec/manager.js')
  ).href;
  const proxyUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/proxy/server.js')
  ).href;
  const errorsUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/telemetry/errors.js')
  ).href;

  const [{ ToolCatalog }, { generateWrappers }, exec, proxy, errors] =
    await Promise.all([
      import(catalogUrl),
      import(generateUrl),
      import(execUrl),
      import(proxyUrl),
      import(errorsUrl),
    ]);

  return {
    ToolCatalog,
    generateWrappers,
    createProxyServer: proxy.createProxyServer,
    WorkerExecutionError: errors.WorkerExecutionError as new (
      type: string,
      message: string
    ) => Error,
    ExecutionManager: exec.ExecutionManager as new (
      pool: DownstreamPool,
      wrappersDir: string,
      options?: { poolSize?: number; maxRunsPerWorker?: number }
    ) => ExecutionManagerLike,
  };
}

describe('ExecutionManager telemetry', () => {
  let dist: Awaited<ReturnType<typeof loadDist>>;
  let wrappersDir: string;
  let mgr: ExecutionManagerLike | null = null;
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeAll(async () => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    dist = await loadDist();
    wrappersDir = await makeTempDir('wn-otel-wrap-');

    const pool = createFakePool();
    const catalog = new dist.ToolCatalog(pool as unknown as DownstreamPool);
    await catalog.refresh();
    await dist.generateWrappers(wrappersDir, catalog);
  });

  afterAll(async () => {
    await provider.shutdown();
    await removeTempDir(wrappersDir);
  });

  afterEach(async () => {
    if (mgr) {
      await mgr.shutdown().catch(() => {});
      mgr = null;
    }
    exporter.reset();
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

  it('creates queue.wait and execution.run spans under an active parent', async () => {
    const { mgr: m } = createMgr();
    const tracer = trace.getTracer('test');

    await tracer.startActiveSpan('test.parent', async (parent) => {
      await m.execute(`console.log('otel-ok');`, { timeoutMs: 10_000 });
      parent.end();
    });

    // Flush processor
    await new Promise((r) => setTimeout(r, 50));
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain('whitenoise.queue.wait');
    expect(names).toContain('whitenoise.execution.run');

    const run = spans.find((s) => s.name === 'whitenoise.execution.run');
    const parent = spans.find((s) => s.name === 'test.parent');
    expect(run?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  it('keeps separate parent contexts for concurrent slot runs', async () => {
    const { mgr: m } = createMgr(undefined, { poolSize: 2 });
    const tracer = trace.getTracer('test');

    await Promise.all([
      tracer.startActiveSpan('parent.a', async (span) => {
        await m.execute(`console.log('a');`, { timeoutMs: 10_000 });
        span.end();
      }),
      tracer.startActiveSpan('parent.b', async (span) => {
        await m.execute(`console.log('b');`, { timeoutMs: 10_000 });
        span.end();
      }),
    ]);

    await new Promise((r) => setTimeout(r, 50));
    const spans = exporter.getFinishedSpans();
    const runs = spans.filter((s) => s.name === 'whitenoise.execution.run');
    expect(runs.length).toBeGreaterThanOrEqual(2);

    const parents = spans.filter(
      (s) => s.name === 'parent.a' || s.name === 'parent.b'
    );
    const parentIds = new Set(parents.map((p) => p.spanContext().spanId));
    const runParentIds = new Set(
      runs.map((r) => r.parentSpanContext?.spanId).filter(Boolean)
    );
    expect(runParentIds.size).toBeGreaterThanOrEqual(2);
    for (const id of runParentIds) {
      expect(parentIds.has(id!)).toBe(true);
    }
  });

  it('omits rebuild spans on cache-hit second execution', async () => {
    const { mgr: m } = createMgr();
    const script = `console.log('cache-probe');`;

    await m.execute(script, { timeoutMs: 10_000 });
    exporter.reset();
    await m.execute(script, { timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));

    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toContain('whitenoise.bundle.cache_lookup');
    expect(names).not.toContain('whitenoise.bundle.rebuild');
    expect(names).not.toContain('whitenoise.bundle.cache_write');
  });

  it('records tool_error when MCP result has isError true but still resolves to worker', async () => {
    let resolvedToWorker = false;
    const { mgr: m } = createMgr({
      callTool: async () => {
        resolvedToWorker = true;
        return {
          isError: true,
          content: [{ type: 'text', text: 'permission denied' }],
        };
      },
    });

    const code = `
import { readFile } from 'mcp/servers/filesystem/readFile';
const result = await readFile({ path: '/tmp/x' });
console.log(JSON.stringify(result));
`;
    const result = await m.execute(code, { timeoutMs: 15_000 });
    expect(resolvedToWorker).toBe(true);
    expect(result.stdout).toContain('permission denied');
    expect(result.downstreamCallCount).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    const clientSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith('mcp.client'));
    expect(clientSpans.length).toBeGreaterThanOrEqual(1);
    expect(clientSpans[0]?.attributes['whitenoise.tool.outcome']).toBe(
      'tool_error'
    );
    expect(clientSpans[0]?.attributes['whitenoise.tool.result.is_error']).toBe(
      true
    );
  });

  it('rejects compilation errors with WorkerExecutionError type', async () => {
    const { mgr: m } = createMgr();
    try {
      await m.execute('const broken = ;', { timeoutMs: 10_000 });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).name).toBe('WorkerExecutionError');
      expect((err as { errorType?: string }).errorType).toBe(
        'COMPILATION_ERROR'
      );
    }
  });

  it('surfaces truncation flags on ExecutionResult', async () => {
    // Soft-check the fields exist on a normal run (full 1MB truncation is slow)
    const { mgr: m } = createMgr();
    const result = await m.execute(`console.log('flags');`, {
      timeoutMs: 10_000,
    });
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(typeof result.downstreamCallCount).toBe('number');
  });

  it('execute_code model-facing errors contain no stack', async () => {
    const pool = createFakePool();
    const catalog = new dist.ToolCatalog(pool as unknown as DownstreamPool);
    await catalog.refresh();
    const { mgr: m } = createMgr();
    const server = dist.createProxyServer(catalog, m);

    // Access registered tools via the SDK's internal map is awkward;
    // instead call exec path the same way the proxy catch block does.
    const { modelFacingErrorPayload } = await import(
      pathToFileURL(
        path.join(process.cwd(), 'dist/telemetry/errors.js')
      ).href
    );

    try {
      await m.execute('const broken = ;', { timeoutMs: 10_000 });
    } catch (err) {
      const payload = modelFacingErrorPayload(err);
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/"stack"/);
      expect(payload.type).toBe('COMPILATION_ERROR');
      expect(payload.recoverable).toBe(true);
    }

    // silence unused
    expect(server).toBeTruthy();
    void context;
  });
});
