// src/exec/worker.ts
import { parentPort } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, copyFile, access, stat } from 'node:fs/promises';
import { context, type BuildContext } from 'esbuild';
import type {
  MainToWorker,
  WorkerToMain,
  WorkerStage,
  WorkerErrorType,
} from './protocol.js';
import { mcpResolverPlugin } from './esbuildPlugin.js';

/** Shared temp base with wrappers — outside the repo / filesystem-server root */
const EXEC_BASE = path.join(os.tmpdir(), 'meta-mcp-proxy', 'exec');
const CACHE_DIR = path.join(EXEC_BASE, 'cache');
const WORK_DIR = path.join(
  EXEC_BASE,
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

function hashScript(script: string, wrappersDir: string): string {
  return createHash('sha256')
    .update(wrappersDir)
    .update('\0')
    .update(script)
    .digest('hex')
    .slice(0, 32);
}

function classifyWorkerError(err: unknown): {
  type: WorkerErrorType;
  message: string;
} {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown worker error';

  if (/hard timeout/i.test(message)) {
    return { type: 'HARD_TIMEOUT', message };
  }

  // esbuild BuildFailure typically has errors[] with location/text
  const anyErr = err as { errors?: unknown[]; name?: string };
  if (
    Array.isArray(anyErr?.errors) ||
    anyErr?.name === 'BuildFailure' ||
    /Transform failed|Build failed|ERROR:/i.test(message)
  ) {
    return { type: 'COMPILATION_ERROR', message };
  }

  if (
    /Cannot find module|MODULE_NOT_FOUND|ENOENT|ERR_MODULE_NOT_FOUND/i.test(
      message
    )
  ) {
    return { type: 'MODULE_NOT_FOUND', message };
  }

  return { type: 'RUNTIME_ERROR', message };
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
  runId: string
): Promise<{ path: string; cacheHit: boolean; bundleBytes?: number }> {
  emitStage(runId, 'bundle.cache_lookup', 'start');
  const hash = hashScript(script, wrappersDir);
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

  const cachePath = path.join(CACHE_DIR, `${hash}.mjs`);
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
  await mkdir(CACHE_DIR, { recursive: true });
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
