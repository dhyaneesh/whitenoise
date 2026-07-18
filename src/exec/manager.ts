// src/exec/manager.ts
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import {
  context as otelContextApi,
  SpanStatusCode,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type {
  WorkerToMain,
  MainToWorker,
  CallToolMessage,
  StageMessage,
  WorkerStage,
} from './protocol.js';
import { parseFqTool } from '../downstream/names.js';
import {
  DownstreamUnavailableError,
  type DownstreamPool,
} from '../downstream/pool.js';
import { GenerationStore, type GenerationId } from '../wrappers/generations.js';
import { ATTR, jsonByteLength, type Outcome, type RecycleReason } from '../telemetry/attributes.js';
import { WorkerExecutionError } from '../telemetry/errors.js';
import {
  contextWithSpan,
  getActiveContext,
  getTracer,
  recordException,
  startChildSpan,
} from '../telemetry/tracing.js';
import {
  recordBundleCacheHit,
  recordBundleCacheMiss,
  recordExecutionCount,
  recordExecutionDuration,
  recordExecutionTimeout,
  recordExecutionToolCalls,
  recordError,
  recordOutputTruncated,
  recordQueueFull,
  recordQueueWait,
  recordRoundTripsAvoided,
  recordToolCall,
  recordToolCallBytes,
  recordToolCallOversize,
  recordWorkerRecycle,
  recordWorkerRun,
  registerPoolGauges,
} from '../telemetry/metrics.js';

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

export type ExecutionResult = {
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  downstreamCallCount: number;
};

type QueuedJob = {
  script: string;
  timeoutMs: number;
  enqueuedAt: number;
  otelContext: Context;
  queueSpan: Span;
  resolve: (result: ExecutionResult) => void;
  reject: (err: unknown) => void;
};

type ActiveRun = {
  id: string;
  job: QueuedJob;
  timer: NodeJS.Timeout;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  runSpan: Span;
  otelContext: Context;
  downstreamCallCount: number;
  intermediateResultBytes: number;
  toolSequence: number;
  openStages: Map<WorkerStage, { start: number; attrs?: StageMessage['payload']['attributes'] }>;
  generationId: GenerationId;
};

type WorkerSlot = {
  id: string;
  worker: Worker;
  activeRun: ActiveRun | null;
  runCount: number;
  /** True while this slot is being replaced; ignore its exit handler respawn */
  retiring: boolean;
};

const STAGE_SPAN_NAMES: Record<WorkerStage, string> = {
  'bundle.cache_lookup': 'whitenoise.bundle.cache_lookup',
  'bundle.context_create': 'whitenoise.bundle.context_create',
  'bundle.source_write': 'whitenoise.bundle.source_write',
  'bundle.rebuild': 'whitenoise.bundle.rebuild',
  'bundle.cache_write': 'whitenoise.bundle.cache_write',
  'execution.user_code': 'whitenoise.execution.user_code',
};

export class ExecutionManager {
  private slots: WorkerSlot[] = [];
  private queue: QueuedJob[] = [];
  private inFlightToolCalls = new Map<
    string,
    { runId: string; slotId: string; controller: AbortController }
  >();
  private readonly poolSize: number;
  private readonly maxRunsPerWorker: number;
  private shuttingDown = false;

  constructor(
    private downstream: DownstreamPool,
    private store: GenerationStore,
    options: { poolSize?: number; maxRunsPerWorker?: number } = {}
  ) {
    this.poolSize = options.poolSize ?? defaultPoolSize();
    this.maxRunsPerWorker = options.maxRunsPerWorker ?? MAX_RUNS_PER_WORKER;
    for (let i = 0; i < this.poolSize; i++) {
      this.slots.push(this.createSlot());
    }
    registerPoolGauges({
      queueDepth: () => this.queue.length,
      poolSize: () => this.poolSize,
      activeWorkers: () =>
        this.slots.filter((s) => !s.retiring && s.activeRun !== null).length,
    });
    console.error(`[exec] worker pool size: ${this.poolSize}`);
  }

  async execute(
    script: string,
    options: { timeoutMs?: number } = {}
  ): Promise<ExecutionResult> {
    if (this.shuttingDown) {
      throw new Error('Proxy shutting down');
    }

    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      recordQueueFull();
      throw new QueueFullError();
    }

    const parentCtx = getActiveContext();
    const queueSpan = getTracer().startSpan(
      'whitenoise.queue.wait',
      undefined,
      parentCtx
    );

    return new Promise((resolve, reject) => {
      this.queue.push({
        script,
        resolve,
        reject,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        enqueuedAt: Date.now(),
        otelContext: parentCtx,
        queueSpan,
      });
      this.pump();
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    for (const job of this.queue) {
      job.queueSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'Proxy shutting down',
      });
      job.queueSpan.end();
      job.reject(new Error('Proxy shutting down'));
    }
    this.queue = [];

    for (const slot of this.slots) {
      slot.retiring = true;
      if (slot.activeRun) {
        clearTimeout(slot.activeRun.timer);
        slot.activeRun.runSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'Proxy shutting down',
        });
        slot.activeRun.runSpan.end();
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
    const queueWaitMs = Date.now() - job.enqueuedAt;
    recordQueueWait(queueWaitMs);
    job.queueSpan.setAttribute('whitenoise.execution.queue_wait.duration_ms', queueWaitMs);
    job.queueSpan.setStatus({ code: SpanStatusCode.OK });
    job.queueSpan.end();

    const runSpan = getTracer().startSpan(
      'whitenoise.execution.run',
      {
        attributes: {
          [ATTR.WORKER_SLOT_ID]: slot.id,
          [ATTR.REQUEST_TIMEOUT_MS]: job.timeoutMs,
        },
      },
      job.otelContext
    );
    const runCtx = contextWithSpan(job.otelContext, runSpan);

    // Pin the current wrapper generation so a mid-run swap doesn't
    // pull files out from under this execution.
    const generation = this.store.acquireCurrent();
    if (!generation) {
      runSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'no generation' });
      runSpan.end();
      job.reject(new Error('No wrapper generation available'));
      return;
    }

    runSpan.setAttribute(ATTR.EXECUTION_RUN_ID, runId);
    runSpan.setAttribute(ATTR.WRAPPER_GENERATION_ID, generation.id);

    const timer = setTimeout(() => {
      this.handleTimeout(slot, runId);
    }, job.timeoutMs);

    slot.activeRun = {
      id: runId,
      job,
      timer,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      runSpan,
      otelContext: runCtx,
      downstreamCallCount: 0,
      intermediateResultBytes: 0,
      toolSequence: 0,
      openStages: new Map(),
      generationId: generation.id,
    };

    slot.worker.postMessage({
      type: 'run',
      id: runId,
      payload: {
        script: job.script,
        wrappersDir: generation.dir,
        generationId: generation.id,
      },
    } satisfies MainToWorker);
  }

  private finishRun(
    slot: WorkerSlot,
    outcome: Outcome,
    durationMs: number,
    result?: ExecutionResult,
    err?: unknown
  ): void {
    const run = slot.activeRun;
    if (!run) return;

    clearTimeout(run.timer);

    run.runSpan.setAttribute(ATTR.OUTCOME, outcome);
    run.runSpan.setAttribute(
      ATTR.EXECUTION_DOWNSTREAM_CALL_COUNT,
      run.downstreamCallCount
    );
    run.runSpan.setAttribute(
      ATTR.EXECUTION_ROUND_TRIPS_AVOIDED,
      Math.max(0, run.downstreamCallCount - 1)
    );
    run.runSpan.setAttribute(
      ATTR.INTERMEDIATE_RESULT_BYTES,
      run.intermediateResultBytes
    );
    run.runSpan.setAttribute(ATTR.STDOUT_TRUNCATED, run.stdoutTruncated);
    run.runSpan.setAttribute(ATTR.STDERR_TRUNCATED, run.stderrTruncated);

    if (result) {
      run.runSpan.setAttribute(
        ATTR.FINAL_RESULT_BYTES,
        Buffer.byteLength(result.stdout, 'utf8') +
          Buffer.byteLength(result.stderr, 'utf8')
      );
    }

    if (err) {
      recordException(run.runSpan, err);
      recordError({ layer: 'exec', type: outcome });
      // Error signature for dedup (hash of type + first detail location or message)
      const sig = errorSignature(outcome, err);
      run.runSpan.setAttribute(ATTR.ERROR_SIGNATURE, sig);
    } else if (outcome === 'success') {
      run.runSpan.setStatus({ code: SpanStatusCode.OK });
    } else {
      run.runSpan.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
    }
    run.runSpan.end();

    recordExecutionDuration(durationMs, outcome);
    recordExecutionCount(outcome);
    recordExecutionToolCalls(run.downstreamCallCount, outcome);
    recordRoundTripsAvoided(Math.max(0, run.downstreamCallCount - 1));
    recordWorkerRun();

    if (run.stdoutTruncated || run.stderrTruncated) {
      recordOutputTruncated();
    }

    // Release the pinned generation so GC can reclaim it if stale.
    this.store.release(run.generationId);

    slot.activeRun = null;
  }

  private handleTimeout(slot: WorkerSlot, runId: string): void {
    if (!slot.activeRun || slot.activeRun.id !== runId) return;

    const job = slot.activeRun.job;
    const err = new ExecutionTimeoutError(runId);
    this.finishRun(slot, 'timeout', job.timeoutMs, undefined, err);
    recordExecutionTimeout();

    this.rejectInFlightToolCalls(runId);
    this.replaceSlot(slot, 'timeout');

    job.reject(err);
    this.pump();
  }

  private handleStage(slot: WorkerSlot, msg: StageMessage): void {
    if (!slot.activeRun || slot.activeRun.id !== msg.id) return;

    const run = slot.activeRun;
    const { stage, state, timestamp, attributes } = msg.payload;

    if (state === 'start') {
      run.openStages.set(stage, { start: timestamp, attrs: attributes });
      return;
    }

    const opened = run.openStages.get(stage);
    run.openStages.delete(stage);
    const startTime = opened?.start ?? timestamp;
    const mergedAttrs = { ...opened?.attrs, ...attributes };

    const child = startChildSpan(
      STAGE_SPAN_NAMES[stage],
      run.otelContext,
      {
        [ATTR.EXECUTION_RUN_ID]: run.id,
        ...(mergedAttrs.cacheHit !== undefined
          ? { [ATTR.BUNDLE_CACHE_HIT]: mergedAttrs.cacheHit }
          : {}),
        ...(mergedAttrs.bundleBytes !== undefined
          ? { [ATTR.BUNDLE_OUTPUT_BYTES]: mergedAttrs.bundleBytes }
          : {}),
      },
      startTime
    );
    child.setStatus({ code: SpanStatusCode.OK });
    child.end(timestamp);

    if (stage === 'bundle.cache_lookup' && mergedAttrs.cacheHit !== undefined) {
      if (mergedAttrs.cacheHit) recordBundleCacheHit();
      else recordBundleCacheMiss();
    }
  }

  private async handleToolCall(
    slot: WorkerSlot,
    msg: CallToolMessage
  ): Promise<void> {
    if (!slot.activeRun) return;

    const run = slot.activeRun;
    const { server, tool } = parseFqTool(msg.payload.fqTool);
    run.toolSequence += 1;
    const sequence = run.toolSequence;
    run.downstreamCallCount += 1;

    const controller = new AbortController();
    this.inFlightToolCalls.set(msg.id, {
      runId: run.id,
      slotId: slot.id,
      controller,
    });

    const argBytes = jsonByteLength(msg.payload.args);
    const policy = this.downstream.getToolPolicy(server, tool);
    const start = Date.now();
    const span = startChildSpan(
      `mcp.client ${server}/${tool}`,
      run.otelContext,
      {
        [ATTR.MCP_METHOD_NAME]: 'tools/call',
        [ATTR.DOWNSTREAM_SERVER]: server,
        [ATTR.GEN_AI_TOOL_NAME]: tool,
        [ATTR.TOOL_CALL_ID]: msg.id,
        [ATTR.TOOL_ARGUMENTS_BYTES]: argBytes,
        [ATTR.TOOL_SEQUENCE]: sequence,
        [ATTR.EXECUTION_RUN_ID]: run.id,
      }
    );

    try {
      const client = this.downstream.getClient(server);
      const result = await otelContextApi.with(run.otelContext, () =>
        client.callTool(
          {
            name: tool,
            arguments: msg.payload.args as Record<string, unknown> | undefined,
          },
          undefined,
          { timeout: policy.timeoutMs, signal: controller.signal }
        )
      );

      this.inFlightToolCalls.delete(msg.id);

      const toolFailed =
        typeof result === 'object' &&
        result !== null &&
        'isError' in result &&
        (result as { isError?: boolean }).isError === true;

      const resultBytes = jsonByteLength(result);
      run.intermediateResultBytes += resultBytes;

      // Oversize guard: reject results exceeding the per-tool limit
      if (resultBytes > policy.maxResultBytes) {
        recordToolCallOversize({ server, tool });
        span.setAttribute(ATTR.TOOL_RESULT_BYTES, resultBytes);
        span.setAttribute(ATTR.TOOL_OUTCOME, 'tool_error');
        span.setAttribute('whitenoise.tool_call.oversize', true);
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'oversize' });
        span.end();
        recordToolCall(Date.now() - start, { server, tool, outcome: 'tool_error' });
        recordToolCallBytes(resultBytes, argBytes, { server, tool });

        if (slot.retiring || !slot.activeRun || slot.activeRun.id !== run.id) {
          return;
        }

        const oversizeResult = {
          isError: true as const,
          content: [
            {
              type: 'text' as const,
              text: `Result exceeds maxResultBytes (${resultBytes} > ${policy.maxResultBytes}) for ${server}/${tool}`,
            },
          ],
        };
        slot.worker.postMessage({
          type: 'callToolResult',
          id: msg.id,
          payload: { ok: true, result: oversizeResult },
        } satisfies MainToWorker);
        return;
      }

      const outcome: Outcome = toolFailed ? 'tool_error' : 'success';
      span.setAttribute(ATTR.TOOL_RESULT_BYTES, resultBytes);
      span.setAttribute(ATTR.TOOL_RESULT_IS_ERROR, toolFailed);
      span.setAttribute(ATTR.TOOL_OUTCOME, outcome);
      if (toolFailed) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool_error' });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();

      recordToolCall(Date.now() - start, { server, tool, outcome });
      recordToolCallBytes(resultBytes, argBytes, { server, tool });

      if (slot.retiring || !slot.activeRun || slot.activeRun.id !== run.id) {
        return;
      }

      // Preserve MCP tool-error envelope for user code (ok: true + result).
      slot.worker.postMessage({
        type: 'callToolResult',
        id: msg.id,
        payload: { ok: true, result },
      } satisfies MainToWorker);
    } catch (err: unknown) {
      this.inFlightToolCalls.delete(msg.id);

      const aborted =
        err instanceof Error &&
        (err.name === 'AbortError' ||
          /abort/i.test(err.message) ||
          controller.signal.aborted);

      const outcome: Outcome = aborted
        ? 'timeout'
        : err instanceof DownstreamUnavailableError
          ? 'downstream_unavailable'
          : 'protocol_error';

      recordException(span, err);
      span.setAttribute(ATTR.TOOL_OUTCOME, outcome);
      span.end();
      recordToolCall(Date.now() - start, { server, tool, outcome });
      recordError({ layer: 'downstream', type: outcome, server, tool });

      console.error('[downstream]', server, 'tool failed', err);

      if (slot.retiring || !slot.activeRun || slot.activeRun.id !== run.id) {
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      slot.worker.postMessage({
        type: 'callToolResult',
        id: msg.id,
        payload: {
          ok: false,
          error: {
            message: aborted ? `Tool call timed out (${policy.timeoutMs}ms)` : message,
            stack,
          },
        },
      } satisfies MainToWorker);
    }
  }

  private handleRunResult(
    slot: WorkerSlot,
    msg: WorkerToMain & { type: 'runResult' }
  ): void {
    if (!slot.activeRun || slot.activeRun.id !== msg.id) return;

    const run = slot.activeRun;
    const { job, stdout, stderr, stdoutTruncated, stderrTruncated } = run;
    slot.runCount += 1;

    if (msg.payload.ok) {
      const result: ExecutionResult = {
        durationMs: msg.payload.durationMs,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        downstreamCallCount: run.downstreamCallCount,
      };
      this.finishRun(slot, 'success', msg.payload.durationMs, result);
      console.error('[exec] run complete', {
        slot: slot.id,
        durationMs: msg.payload.durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        runCount: slot.runCount,
      });
      job.resolve(result);
    } else {
      const err = new WorkerExecutionError(
        msg.payload.error.type,
        msg.payload.error.message,
        msg.payload.error.details
      );
      const outcome: Outcome =
        msg.payload.error.type === 'COMPILATION_ERROR'
          ? 'compilation_error'
          : msg.payload.error.type === 'MODULE_NOT_FOUND'
            ? 'module_not_found'
            : msg.payload.error.type === 'HARD_TIMEOUT'
              ? 'timeout'
              : 'runtime_error';
      this.finishRun(slot, outcome, 0, undefined, err);
      job.reject(err);
    }

    // Recycle after N runs to reclaim leaked ESM module cache
    if (slot.runCount >= this.maxRunsPerWorker && !slot.retiring) {
      console.error(
        `[exec] recycling worker ${slot.id} after ${slot.runCount} runs`
      );
      this.replaceSlot(slot, 'max_runs');
    }

    this.pump();
  }

  private rejectInFlightToolCalls(runId: string): void {
    for (const [callId, info] of this.inFlightToolCalls) {
      if (info.runId === runId) {
        info.controller.abort();
        this.inFlightToolCalls.delete(callId);
      }
    }
  }

  private handleWorkerError(slot: WorkerSlot, error: Error): void {
    if (slot.retiring) return;
    console.error('[exec] worker error:', slot.id, error);

    if (slot.activeRun) {
      const runId = slot.activeRun.id;
      const job = slot.activeRun.job;
      const err = new WorkerCrashedError(error.message);
      this.rejectInFlightToolCalls(runId);
      this.finishRun(slot, 'worker_crash', 0, undefined, err);
      job.reject(err);
    }

    this.replaceSlot(slot, 'crash');
    this.pump();
  }

  private handleWorkerExit(slot: WorkerSlot, code: number): void {
    if (slot.retiring) return;

    if (code !== 0) {
      console.error(`[exec] worker ${slot.id} exited with code ${code}`);
    }

    if (slot.activeRun) {
      const runId = slot.activeRun.id;
      const job = slot.activeRun.job;
      const err = new WorkerCrashedError(`Worker exited with code ${code}`);
      this.rejectInFlightToolCalls(runId);
      this.finishRun(slot, 'worker_crash', 0, undefined, err);
      job.reject(err);
    }

    this.replaceSlot(slot, code !== 0 ? 'nonzero_exit' : 'crash');
    this.pump();
  }

  private appendOutput(
    slot: WorkerSlot,
    stream: 'stdout' | 'stderr',
    chunk: Buffer
  ): void {
    if (!slot.activeRun) return;

    const current = slot.activeRun[stream];
    if (current.length >= MAX_OUTPUT_BYTES) {
      if (stream === 'stdout') slot.activeRun.stdoutTruncated = true;
      else slot.activeRun.stderrTruncated = true;
      return;
    }

    let text = chunk.toString('utf8');
    const remaining = MAX_OUTPUT_BYTES - current.length;

    if (text.length > remaining) {
      text = text.slice(0, remaining) + '\n[output truncated]';
      if (stream === 'stdout') slot.activeRun.stdoutTruncated = true;
      else slot.activeRun.stderrTruncated = true;
    }

    slot.activeRun[stream] += text;
  }

  private replaceSlot(oldSlot: WorkerSlot, reason: RecycleReason): void {
    oldSlot.retiring = true;
    recordWorkerRecycle(reason);
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
      } else if (msg.type === 'stage') {
        this.handleStage(slot, msg);
      } else if (msg.type === 'runResult') {
        this.handleRunResult(slot, msg);
      }
    });

    worker.on('error', (err) => this.handleWorkerError(slot, err));
    worker.on('exit', (code) => this.handleWorkerExit(slot, code ?? 1));

    return slot;
  }
}

/** Compute a low-cardinality error signature for dedup. */
function errorSignature(outcome: string, err: unknown): string {
  const wErr = err as { details?: Array<{ file?: string; line?: number }> };
  const firstDetail = wErr?.details?.[0];
  const loc = firstDetail
    ? `${firstDetail.file ?? ''}:${firstDetail.line ?? 0}`
    : '';
  const msg = err instanceof Error ? err.message : String(err);
  // Normalize: strip paths and numbers to bound cardinality
  const normalized = msg.replace(/\/[^\s:]+/g, '<path>').replace(/\d+/g, 'N');
  return ATTR.ERROR_SIGNATURE === 'whitenoise.error.signature'
    ? `${outcome}:${loc}:${normalized.slice(0, 100)}`
    : outcome;
}
