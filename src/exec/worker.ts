// src/exec/worker.ts
import { parentPort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import type { MainToWorker, WorkerToMain } from './protocol.js';
import { mcpResolverPlugin } from './esbuildPlugin.js';

const MAX_EXEC_MS = 60_000;

const pending = new Map<string, { resolve: Function; reject: Function }>();

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

parentPort!.on('message', async (msg: MainToWorker) => {
  if (msg.type === 'run') {
    const start = Date.now();
    const runId = msg.id;
    const execDir = path.join(process.cwd(), '.exec', runId);

    // Hard execution ceiling - manager will catch crash + respawn
    const hardTimeout = setTimeout(() => {
      throw new Error('Worker hard timeout exceeded');
    }, MAX_EXEC_MS);

    try {
      // Create isolated exec directory
      await mkdir(execDir, { recursive: true });

      // Write entry file
      const entryPath = path.join(execDir, 'entry.ts');
      await writeFile(entryPath, msg.payload.script, 'utf8');

      // Bundle with esbuild
      const outfile = path.join(execDir, 'bundle.mjs');
      await build({
        entryPoints: [entryPath],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile,
        external: ['node:*'],
        plugins: [mcpResolverPlugin(msg.payload.wrappersDir)],
      });

      // Import and execute
      await import(pathToFileURL(outfile).href);

      clearTimeout(hardTimeout);

      // Cleanup (unless DEBUG_EXEC set)
      if (!process.env.DEBUG_EXEC) {
        await rm(execDir, { recursive: true, force: true }).catch(() => {});
      }

      parentPort!.postMessage({
        type: 'runResult',
        id: runId,
        payload: { ok: true, durationMs: Date.now() - start },
      } satisfies WorkerToMain);
    } catch (err: any) {
      clearTimeout(hardTimeout);

      // Cleanup on error too
      if (!process.env.DEBUG_EXEC) {
        await rm(execDir, { recursive: true, force: true }).catch(() => {});
      }

      parentPort!.postMessage({
        type: 'runResult',
        id: runId,
        payload: {
          ok: false,
          error: { message: err.message, stack: err.stack },
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

// Export for cleanup on crash (called by manager if needed)
export function rejectAllPending(error: Error): void {
  for (const [id, p] of pending) {
    p.reject(error);
  }
  pending.clear();
}
