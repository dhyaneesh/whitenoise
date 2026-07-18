// src/exec/worker.ts
import { parentPort } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, copyFile, access, stat } from 'node:fs/promises';
import { context, type BuildContext } from 'esbuild';
import type {
  MainToWorker,
  WorkerToMain,
  WorkerStage,
} from './protocol.js';
import { mcpResolverPlugin } from './esbuildPlugin.js';
import { classifyWorkerError } from './classify.js';
import { BUNDLE_CACHE_ROOT, EXEC_ROOT } from '../paths.js';

/** Per-worker scratch directory for entry files (outside the repo) */
const WORK_DIR = path.join(
  EXEC_ROOT,
  `w-${process.pid}-${randomUUID().slice(0, 8)}`
);

const MAX_EXEC_MS = 60_000;

const pending = new Map<string, { resolve: Function; reject: Function }>();

/** In-memory map of scriptHash -> absolute path to cached bundle.mjs */
const bundleCache = new Map<string, string>();

let buildCtx: BuildContext | null = null;
let currentWrappersDir: string | null = null;

function emitStage(
  runId: string,
  stage: WorkerStage,
  state: 'start' | 'end',
  attributes?: { cacheHit?: boolean; bundleBytes?: number }
): void {
  parentPort!.postMessage({
    type: 'stage',
    id: runId,
    payload: {
      stage,
      state,
      timestamp: Date.now(),
      attributes,
    },
  } satisfies WorkerToMain);
}

// The bridge function - called by generated wrappers via globalThis
function callMCPTool(fqTool: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    parentPort!.postMessage({
      type: 'callTool',
      id,
      payload: { fqTool, args },
    } satisfies WorkerToMain);
  });
}

// Make it available globally BEFORE any bundle import
(globalThis as any).__callMCPTool = callMCPTool;

function hashScript(script: string, generationId: number): string {
  return createHash('sha256')
    .update(String(generationId))
    .update('\0')
    .update(script)
    .digest('hex')
    .slice(0, 32);
}

async function getOrCreateContext(
  wrappersDir: string,
  runId: string
): Promise<{
  ctx: BuildContext;
  entryPath: string;
  outfile: string;
}> {
  const entryPath = path.join(WORK_DIR, 'entry.ts');
  const outfile = path.join(WORK_DIR, 'bundle.mjs');

  if (buildCtx && currentWrappersDir === wrappersDir) {
    return { ctx: buildCtx, entryPath, outfile };
  }

  emitStage(runId, 'bundle.context_create', 'start');
  try {
    if (buildCtx) {
      await buildCtx.dispose().catch(() => {});
      buildCtx = null;
    }

    await mkdir(WORK_DIR, { recursive: true });
    await writeFile(entryPath, '// placeholder\n', 'utf8');

    buildCtx = await context({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      external: ['node:*'],
      plugins: [mcpResolverPlugin(wrappersDir)],
    });
    currentWrappersDir = wrappersDir;
  } finally {
    emitStage(runId, 'bundle.context_create', 'end');
  }

  return { ctx: buildCtx, entryPath, outfile };
}

async function getBundlePath(
  script: string,
  wrappersDir: string,
  generationId: number,
  runId: string
): Promise<{ path: string; cacheHit: boolean; bundleBytes?: number }> {
  emitStage(runId, 'bundle.cache_lookup', 'start');
  const hash = hashScript(script, generationId);
  const genCacheDir = path.join(BUNDLE_CACHE_ROOT, `gen-${generationId}`);
  const cached = bundleCache.get(hash);
  if (cached) {
    try {
      await access(cached);
      const st = await stat(cached);
      emitStage(runId, 'bundle.cache_lookup', 'end', {
        cacheHit: true,
        bundleBytes: st.size,
      });
      return { path: cached, cacheHit: true, bundleBytes: st.size };
    } catch {
      bundleCache.delete(hash);
    }
  }

  const cachePath = path.join(genCacheDir, `${hash}.mjs`);
  try {
    await access(cachePath);
    bundleCache.set(hash, cachePath);
    const st = await stat(cachePath);
    emitStage(runId, 'bundle.cache_lookup', 'end', {
      cacheHit: true,
      bundleBytes: st.size,
    });
    return { path: cachePath, cacheHit: true, bundleBytes: st.size };
  } catch {
    // not on disk yet
  }
  emitStage(runId, 'bundle.cache_lookup', 'end', { cacheHit: false });

  const { ctx, entryPath, outfile } = await getOrCreateContext(
    wrappersDir,
    runId
  );

  emitStage(runId, 'bundle.source_write', 'start');
  await writeFile(entryPath, script, 'utf8');
  emitStage(runId, 'bundle.source_write', 'end');

  emitStage(runId, 'bundle.rebuild', 'start');
  await ctx.rebuild();
  emitStage(runId, 'bundle.rebuild', 'end');

  emitStage(runId, 'bundle.cache_write', 'start');
  await mkdir(genCacheDir, { recursive: true });
  await copyFile(outfile, cachePath);
  const st = await stat(cachePath);
  emitStage(runId, 'bundle.cache_write', 'end', { bundleBytes: st.size });

  bundleCache.set(hash, cachePath);
  return { path: cachePath, cacheHit: false, bundleBytes: st.size };
}

parentPort!.on('message', async (msg: MainToWorker) => {
  if (msg.type === 'run') {
    const start = Date.now();
    const runId = msg.id;

    // Drop any stale tool-call promises from a prior aborted run
    for (const [, p] of pending) {
      p.reject(new Error('Superseded by new run'));
    }
    pending.clear();

    // Hard execution ceiling - manager will catch crash + respawn
    const hardTimeout = setTimeout(() => {
      throw new Error('Worker hard timeout exceeded');
    }, MAX_EXEC_MS);

    try {
      const { path: bundlePath } = await getBundlePath(
        msg.payload.script,
        msg.payload.wrappersDir,
        msg.payload.generationId,
        runId
      );

      // Unique query forces re-execution of top-level code even when the
      // on-disk bundle is shared across runs (esbuild cache hit).
      const href = `${pathToFileURL(bundlePath).href}?run=${runId}`;
      emitStage(runId, 'execution.user_code', 'start');
      try {
        await import(href);
      } finally {
        emitStage(runId, 'execution.user_code', 'end');
      }

      clearTimeout(hardTimeout);

      // Drain buffered stdout/stderr before reporting completion so the
      // manager reliably captures all output (worker thread pipe flushes
      // are not ordered relative to postMessage).
      await new Promise<void>((resolve) => {
        process.stdout.write('', () => {
          process.stderr.write('', () => resolve());
        });
      });

      parentPort!.postMessage({
        type: 'runResult',
        id: runId,
        payload: { ok: true, durationMs: Date.now() - start },
      } satisfies WorkerToMain);
    } catch (err: any) {
      clearTimeout(hardTimeout);
      const classified = classifyWorkerError(err);

      parentPort!.postMessage({
        type: 'runResult',
        id: runId,
        payload: {
          ok: false,
          error: classified,
        },
      } satisfies WorkerToMain);
    }
  } else if (msg.type === 'callToolResult') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);

    if (msg.payload.ok) {
      p.resolve(msg.payload.result);
    } else {
      const err = new Error(msg.payload.error.message);
      err.stack = msg.payload.error.stack;
      p.reject(err);
    }
  }
});
