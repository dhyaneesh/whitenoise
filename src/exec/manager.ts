// src/exec/manager.ts
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkerToMain, MainToWorker, CallToolMessage } from './protocol.js';
import { parseFqTool } from '../downstream/names.js';
import type { DownstreamPool } from '../downstream/pool.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_QUEUE_LENGTH = 50;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB cap

export class ExecutionTimeoutError extends Error {
  constructor(runId: string) {
    super(`Execution timed out: ${runId}`);
    this.name = 'ExecutionTimeoutError';
  }
}

export class WorkerCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerCrashedError';
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('Execution queue is full');
    this.name = 'QueueFullError';
  }
}

type QueuedJob = {
  script: string;
  resolve: (result: { durationMs: number; stdout: string; stderr: string }) => void;
  reject: (err: any) => void;
  timeoutMs: number;
};

type ActiveRun = {
  id: string;
  job: QueuedJob;
  timer: NodeJS.Timeout;
  stdout: string;
  stderr: string;
};

export class ExecutionManager {
  private worker: Worker | null = null;
  private activeRun: ActiveRun | null = null;
  private queue: QueuedJob[] = [];
  private inFlightToolCalls = new Map<string, { runId: string }>();

  constructor(
    private pool: DownstreamPool,
    private wrappersDir: string
  ) {
    this.spawnWorker();
  }

  async execute(
    script: string,
    options: { timeoutMs?: number } = {}
  ): Promise<{ durationMs: number; stdout: string; stderr: string }> {
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      throw new QueueFullError();
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        script,
        resolve,
        reject,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      if (!this.activeRun) {
        this.startNext();
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }

    if (this.activeRun) {
      clearTimeout(this.activeRun.timer);
      this.activeRun.job.reject(new Error('Proxy shutting down'));
      this.activeRun = null;
    }

    for (const job of this.queue) {
      job.reject(new Error('Proxy shutting down'));
    }
    this.queue = [];
  }

  private startNext(): void {
    const job = this.queue.shift();
    if (!job || !this.worker) return;

    // Sanity check: should never have active run when starting next
    if (this.activeRun && this.queue.length > 0) {
      console.warn('[exec] invariant violation: active + queued');
    }

    const runId = randomUUID();

    const timer = setTimeout(() => {
      this.handleTimeout(runId);
    }, job.timeoutMs);

    this.activeRun = {
      id: runId,
      job,
      timer,
      stdout: '',
      stderr: '',
    };

    this.worker.postMessage({
      type: 'run',
      id: runId,
      payload: {
        script: job.script,
        wrappersDir: this.wrappersDir,
      },
    } satisfies MainToWorker);
  }

  private handleTimeout(runId: string): void {
    if (!this.activeRun || this.activeRun.id !== runId) return;

    const job = this.activeRun.job;
    this.activeRun = null;

    // Reject all in-flight tool calls for this run
    this.rejectInFlightToolCalls(runId, new ExecutionTimeoutError(runId));

    // Terminate and respawn worker
    this.worker?.terminate();
    this.spawnWorker();

    job.reject(new ExecutionTimeoutError(runId));
    this.startNext();
  }

  private async handleToolCall(msg: CallToolMessage): Promise<void> {
    if (!this.worker) return;
    if (!this.activeRun) return;

    const { server, tool } = parseFqTool(msg.payload.fqTool);
    this.inFlightToolCalls.set(msg.id, { runId: this.activeRun.id });

    try {
      const client = this.pool.getClient(server);
      const result = await client.callTool({
        name: tool,
        arguments: msg.payload.args as Record<string, unknown> | undefined,
      });

      this.inFlightToolCalls.delete(msg.id);

      this.worker?.postMessage({
        type: 'callToolResult',
        id: msg.id,
        payload: { ok: true, result },
      } satisfies MainToWorker);
    } catch (err: any) {
      console.error('[downstream]', server, 'tool failed', err);
      this.inFlightToolCalls.delete(msg.id);

      this.worker?.postMessage({
        type: 'callToolResult',
        id: msg.id,
        payload: {
          ok: false,
          error: { message: err.message, stack: err.stack },
        },
      } satisfies MainToWorker);
    }
  }

  private handleRunResult(msg: WorkerToMain & { type: 'runResult' }): void {
    if (!this.worker) return;
    if (!this.activeRun || this.activeRun.id !== msg.id) return;

    clearTimeout(this.activeRun.timer);
    const { job, stdout, stderr } = this.activeRun;
    this.activeRun = null;

    if (msg.payload.ok) {
      console.info('[exec] run complete', {
        durationMs: msg.payload.durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      });
      job.resolve({ durationMs: msg.payload.durationMs, stdout, stderr });
    } else {
      const err = new Error(msg.payload.error.message);
      err.stack = msg.payload.error.stack;
      job.reject(err);
    }

    this.startNext();
  }

  private rejectInFlightToolCalls(runId: string, error: Error): void {
    for (const [callId, info] of this.inFlightToolCalls) {
      if (info.runId === runId) {
        this.inFlightToolCalls.delete(callId);
        // Tool call promises in worker will be rejected when worker crashes
      }
    }
  }

  private handleWorkerError(error: Error): void {
    console.error('[exec] worker error:', error);

    if (this.activeRun) {
      clearTimeout(this.activeRun.timer);
      this.activeRun.job.reject(new WorkerCrashedError(error.message));
      this.rejectInFlightToolCalls(this.activeRun.id, error);
      this.activeRun = null;
    }

    this.spawnWorker();
    this.startNext();
  }

  private handleWorkerExit(code: number): void {
    if (code !== 0) {
      console.error(`[exec] worker exited with code ${code}`);
    }

    if (this.activeRun) {
      clearTimeout(this.activeRun.timer);
      this.activeRun.job.reject(new WorkerCrashedError(`Worker exited with code ${code}`));
      this.rejectInFlightToolCalls(this.activeRun.id, new Error('Worker exited'));
      this.activeRun = null;
    }

    this.spawnWorker();
    this.startNext();
  }

  private appendOutput(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (!this.activeRun) return;

    const current = this.activeRun[stream];
    if (current.length >= MAX_OUTPUT_BYTES) return;

    let text = chunk.toString('utf8');
    const remaining = MAX_OUTPUT_BYTES - current.length;

    if (text.length > remaining) {
      text = text.slice(0, remaining) + '\n[output truncated]';
    }

    this.activeRun[stream] += text;
  }

  private spawnWorker(): void {
    const workerPath = path.resolve('dist/exec/worker.js');

    this.worker = new Worker(workerPath, {
      stdout: true,
      stderr: true,
    });

    this.worker.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput('stdout', chunk);
      // Also echo to main stderr for visibility
      process.stderr.write(chunk);
    });

    this.worker.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput('stderr', chunk);
      process.stderr.write(chunk);
    });

    this.worker.on('message', (msg: WorkerToMain) => {
      if (msg.type === 'callTool') {
        this.handleToolCall(msg);
      } else if (msg.type === 'runResult') {
        this.handleRunResult(msg);
      }
    });

    this.worker.on('error', (err) => this.handleWorkerError(err));
    this.worker.on('exit', (code) => this.handleWorkerExit(code ?? 1));
  }
}
