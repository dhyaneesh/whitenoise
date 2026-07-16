// src/exec/manager.ts
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import type { WorkerToMain, MainToWorker, CallToolMessage } from './protocol.js';
import { parseFqTool } from '../downstream/names.js';
import type { DownstreamPool } from '../downstream/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_QUEUE_LENGTH = 50;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB cap
/** Recycle a worker after this many runs to reclaim the ESM module cache */
const MAX_RUNS_PER_WORKER = 50;

function defaultPoolSize(): number {
  try {
    return Math.min(4, Math.max(1, availableParallelism()));
  } catch {
    return 2;
  }
}

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

type WorkerSlot = {
  id: string;
  worker: Worker;
  activeRun: ActiveRun | null;
  runCount: number;
  /** True while this slot is being replaced; ignore its exit handler respawn */
  retiring: boolean;
};

export class ExecutionManager {
  private slots: WorkerSlot[] = [];
  private queue: QueuedJob[] = [];
  private inFlightToolCalls = new Map<
    string,
    { runId: string; slotId: string }
  >();
  private readonly poolSize: number;
  private readonly maxRunsPerWorker: number;
  private shuttingDown = false;

  constructor(
    private downstream: DownstreamPool,
    private wrappersDir: string,
    options: { poolSize?: number; maxRunsPerWorker?: number } = {}
  ) {
    this.poolSize = options.poolSize ?? defaultPoolSize();
    this.maxRunsPerWorker = options.maxRunsPerWorker ?? MAX_RUNS_PER_WORKER;
    for (let i = 0; i < this.poolSize; i++) {
      this.slots.push(this.createSlot());
    }
    console.error(`[exec] worker pool size: ${this.poolSize}`);
  }

  async execute(
    script: string,
    options: { timeoutMs?: number } = {}
  ): Promise<{ durationMs: number; stdout: string; stderr: string }> {
    if (this.shuttingDown) {
      throw new Error('Proxy shutting down');
    }

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
      this.pump();
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    for (const job of this.queue) {
      job.reject(new Error('Proxy shutting down'));
    }
    this.queue = [];

    for (const slot of this.slots) {
      slot.retiring = true;
      if (slot.activeRun) {
        clearTimeout(slot.activeRun.timer);
        slot.activeRun.job.reject(new Error('Proxy shutting down'));
        slot.activeRun = null;
      }
      await slot.worker.terminate().catch(() => {});
    }
    this.slots = [];
  }

  /** Dispatch queued jobs to any idle workers */
  private pump(): void {
    if (this.shuttingDown) return;

    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => !s.retiring && !s.activeRun);
      if (!slot) break;

      const job = this.queue.shift()!;
      this.startOnSlot(slot, job);
    }
  }

  private startOnSlot(slot: WorkerSlot, job: QueuedJob): void {
    const runId = randomUUID();

    const timer = setTimeout(() => {
      this.handleTimeout(slot, runId);
    }, job.timeoutMs);

    slot.activeRun = {
      id: runId,
      job,
      timer,
      stdout: '',
      stderr: '',
    };

    slot.worker.postMessage({
      type: 'run',
      id: runId,
      payload: {
        script: job.script,
        wrappersDir: this.wrappersDir,
      },
    } satisfies MainToWorker);
  }

  private handleTimeout(slot: WorkerSlot, runId: string): void {
    if (!slot.activeRun || slot.activeRun.id !== runId) return;

    const job = slot.activeRun.job;
    slot.activeRun = null;

    this.rejectInFlightToolCalls(runId);

    // Kill and replace this slot — timeout may leave the worker hung
    this.replaceSlot(slot);

    job.reject(new ExecutionTimeoutError(runId));
    this.pump();
  }

  private async handleToolCall(
    slot: WorkerSlot,
    msg: CallToolMessage
  ): Promise<void> {
    if (!slot.activeRun) return;

    const { server, tool } = parseFqTool(msg.payload.fqTool);
    this.inFlightToolCalls.set(msg.id, {
      runId: slot.activeRun.id,
      slotId: slot.id,
    });

    try {
      const client = this.downstream.getClient(server);
      const result = await client.callTool({
        name: tool,
        arguments: msg.payload.args as Record<string, unknown> | undefined,
      });

      this.inFlightToolCalls.delete(msg.id);

      if (slot.retiring || !slot.activeRun) return;

      slot.worker.postMessage({
        type: 'callToolResult',
        id: msg.id,
        payload: { ok: true, result },
      } satisfies MainToWorker);
    } catch (err: any) {
      console.error('[downstream]', server, 'tool failed', err);
      this.inFlightToolCalls.delete(msg.id);

      if (slot.retiring || !slot.activeRun) return;

      slot.worker.postMessage({
        type: 'callToolResult',
        id: msg.id,
        payload: {
          ok: false,
          error: { message: err.message, stack: err.stack },
        },
      } satisfies MainToWorker);
    }
  }

  private handleRunResult(
    slot: WorkerSlot,
    msg: WorkerToMain & { type: 'runResult' }
  ): void {
    if (!slot.activeRun || slot.activeRun.id !== msg.id) return;

    clearTimeout(slot.activeRun.timer);
    const { job, stdout, stderr } = slot.activeRun;
    slot.activeRun = null;
    slot.runCount += 1;

    if (msg.payload.ok) {
      console.error('[exec] run complete', {
        slot: slot.id,
        durationMs: msg.payload.durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        runCount: slot.runCount,
      });
      job.resolve({ durationMs: msg.payload.durationMs, stdout, stderr });
    } else {
      const err = new Error(msg.payload.error.message);
      err.stack = msg.payload.error.stack;
      job.reject(err);
    }

    // Recycle after N runs to reclaim leaked ESM module cache
    if (slot.runCount >= this.maxRunsPerWorker && !slot.retiring) {
      console.error(
        `[exec] recycling worker ${slot.id} after ${slot.runCount} runs`
      );
      this.replaceSlot(slot);
    }

    this.pump();
  }

  private rejectInFlightToolCalls(runId: string): void {
    for (const [callId, info] of this.inFlightToolCalls) {
      if (info.runId === runId) {
        this.inFlightToolCalls.delete(callId);
      }
    }
  }

  private handleWorkerError(slot: WorkerSlot, error: Error): void {
    if (slot.retiring) return;
    console.error('[exec] worker error:', slot.id, error);

    if (slot.activeRun) {
      clearTimeout(slot.activeRun.timer);
      slot.activeRun.job.reject(new WorkerCrashedError(error.message));
      this.rejectInFlightToolCalls(slot.activeRun.id);
      slot.activeRun = null;
    }

    this.replaceSlot(slot);
    this.pump();
  }

  private handleWorkerExit(slot: WorkerSlot, code: number): void {
    if (slot.retiring) return;

    if (code !== 0) {
      console.error(`[exec] worker ${slot.id} exited with code ${code}`);
    }

    if (slot.activeRun) {
      clearTimeout(slot.activeRun.timer);
      slot.activeRun.job.reject(
        new WorkerCrashedError(`Worker exited with code ${code}`)
      );
      this.rejectInFlightToolCalls(slot.activeRun.id);
      slot.activeRun = null;
    }

    this.replaceSlot(slot);
    this.pump();
  }

  private appendOutput(
    slot: WorkerSlot,
    stream: 'stdout' | 'stderr',
    chunk: Buffer
  ): void {
    if (!slot.activeRun) return;

    const current = slot.activeRun[stream];
    if (current.length >= MAX_OUTPUT_BYTES) return;

    let text = chunk.toString('utf8');
    const remaining = MAX_OUTPUT_BYTES - current.length;

    if (text.length > remaining) {
      text = text.slice(0, remaining) + '\n[output truncated]';
    }

    slot.activeRun[stream] += text;
  }

  private replaceSlot(oldSlot: WorkerSlot): void {
    oldSlot.retiring = true;
    void oldSlot.worker.terminate().catch(() => {});

    const idx = this.slots.indexOf(oldSlot);
    if (idx === -1 || this.shuttingDown) return;

    const fresh = this.createSlot();
    this.slots[idx] = fresh;
  }

  private createSlot(): WorkerSlot {
    const id = randomUUID().slice(0, 8);
    const workerPath = path.join(__dirname, 'worker.js');

    const worker = new Worker(workerPath, {
      stdout: true,
      stderr: true,
    });

    const slot: WorkerSlot = {
      id,
      worker,
      activeRun: null,
      runCount: 0,
      retiring: false,
    };

    worker.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput(slot, 'stdout', chunk);
    });

    worker.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput(slot, 'stderr', chunk);
    });

    worker.on('message', (msg: WorkerToMain) => {
      if (msg.type === 'callTool') {
        void this.handleToolCall(slot, msg);
      } else if (msg.type === 'runResult') {
        this.handleRunResult(slot, msg);
      }
    });

    worker.on('error', (err) => this.handleWorkerError(slot, err));
    worker.on('exit', (code) => this.handleWorkerExit(slot, code ?? 1));

    return slot;
  }
}
