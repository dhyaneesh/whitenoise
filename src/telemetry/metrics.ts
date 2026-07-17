// src/telemetry/metrics.ts
import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
  type BatchObservableResult,
} from '@opentelemetry/api';
import type { Outcome, RecycleReason } from './attributes.js';

const METER_NAME = 'whitenoise';

let meter: Meter | null = null;

export function getMeter(): Meter {
  if (!meter) {
    meter = metrics.getMeter(METER_NAME, '0.1.0');
  }
  return meter;
}

type Instruments = {
  executionDuration: Histogram;
  executionQueueWait: Histogram;
  executionCount: Counter;
  executionTimeouts: Counter;
  executionQueueFull: Counter;
  executionOutputTruncated: Counter;
  toolCallDuration: Histogram;
  toolCallCount: Counter;
  workerRecycleCount: Counter;
  workerRunCount: Counter;
  bundleCacheHit: Counter;
  bundleCacheMiss: Counter;
  searchDuration: Histogram;
  searchZeroMatchCount: Counter;
  contextDiscoveryBytes: Histogram;
  executionToolCalls: Histogram;
  executionRoundTripsAvoided: Histogram;
  catalogRefreshDuration: Histogram;
  catalogRefreshFailedServers: Counter;
  catalogRefreshCoalesced: Counter;
  wrapperGeneratedCount: Counter;
  downstreamReconnectCount: Counter;
  modulesRead: Counter;
};

let instruments: Instruments | null = null;

function ensureInstruments(): Instruments {
  if (instruments) return instruments;
  const m = getMeter();
  instruments = {
    executionDuration: m.createHistogram('whitenoise.execution.duration', {
      unit: 'ms',
      description: 'execute_code wall duration',
    }),
    executionQueueWait: m.createHistogram('whitenoise.execution.queue_wait', {
      unit: 'ms',
      description: 'Time spent waiting in the execution queue',
    }),
    executionCount: m.createCounter('whitenoise.execution.count', {
      description: 'Number of execute_code runs by outcome',
    }),
    executionTimeouts: m.createCounter('whitenoise.execution.timeouts', {
      description: 'Soft execution timeouts',
    }),
    executionQueueFull: m.createCounter('whitenoise.execution.queue_full', {
      description: 'Rejected executions because the queue was full',
    }),
    executionOutputTruncated: m.createCounter(
      'whitenoise.execution.output_truncated',
      { description: 'Runs where stdout or stderr was truncated' }
    ),
    toolCallDuration: m.createHistogram('whitenoise.tool_call.duration', {
      unit: 'ms',
      description: 'Downstream MCP tool call duration',
    }),
    toolCallCount: m.createCounter('whitenoise.tool_call.count', {
      description: 'Downstream MCP tool calls by outcome',
    }),
    workerRecycleCount: m.createCounter('whitenoise.worker.recycle.count', {
      description: 'Worker slot replacements by reason',
    }),
    workerRunCount: m.createCounter('whitenoise.worker.run_count', {
      description: 'Completed runs attributed to workers',
    }),
    bundleCacheHit: m.createCounter('whitenoise.bundle.cache_hit', {
      description: 'Bundle cache hits',
    }),
    bundleCacheMiss: m.createCounter('whitenoise.bundle.cache_miss', {
      description: 'Bundle cache misses requiring rebuild',
    }),
    searchDuration: m.createHistogram('whitenoise.search.duration', {
      unit: 'ms',
      description: 'search_tools duration',
    }),
    searchZeroMatchCount: m.createCounter(
      'whitenoise.search.zero_match.count',
      { description: 'Searches with zero positive score matches' }
    ),
    contextDiscoveryBytes: m.createHistogram(
      'whitenoise.context.discovery.bytes',
      {
        unit: 'By',
        description: 'Discovery response bytes by meta-tool',
      }
    ),
    executionToolCalls: m.createHistogram('whitenoise.execution.tool_calls', {
      description: 'Downstream tool calls per execute_code run',
    }),
    executionRoundTripsAvoided: m.createHistogram(
      'whitenoise.execution.round_trips_avoided',
      {
        description:
          'Estimated model round trips avoided (max(0, downstream_calls - 1))',
      }
    ),
    catalogRefreshDuration: m.createHistogram(
      'whitenoise.catalog.refresh.duration',
      { unit: 'ms', description: 'Catalog refresh duration' }
    ),
    catalogRefreshFailedServers: m.createCounter(
      'whitenoise.catalog.refresh.failed_servers',
      { description: 'Servers that failed during catalog refresh' }
    ),
    catalogRefreshCoalesced: m.createCounter(
      'whitenoise.catalog.refresh.coalesced',
      { description: 'Catalog refresh triggers coalesced by single-flight' }
    ),
    wrapperGeneratedCount: m.createCounter(
      'whitenoise.wrapper.generated_count',
      { description: 'Wrapper files generated' }
    ),
    downstreamReconnectCount: m.createCounter(
      'whitenoise.downstream.reconnect.count',
      { description: 'Downstream reconnect attempts by outcome' }
    ),
    modulesRead: m.createCounter('whitenoise.context.modules_read', {
      description: 'read_module calls',
    }),
  };
  return instruments;
}

/** Observable gauges for pool/queue state — callbacks set by ExecutionManager. */
export type PoolGaugeCallbacks = {
  queueDepth: () => number;
  poolSize: () => number;
  activeWorkers: () => number;
};

let poolGaugesRegistered = false;
let poolCallbacks: PoolGaugeCallbacks | null = null;

export function registerPoolGauges(callbacks: PoolGaugeCallbacks): void {
  poolCallbacks = callbacks;
  if (poolGaugesRegistered) return;
  poolGaugesRegistered = true;
  const m = getMeter();

  const queueDepth: ObservableGauge = m.createObservableGauge(
    'whitenoise.execution.queue_depth',
    { description: 'Current execution queue length' }
  );
  const poolSize: ObservableGauge = m.createObservableGauge(
    'whitenoise.worker.pool.size',
    { description: 'Configured worker pool size' }
  );
  const active: ObservableGauge = m.createObservableGauge(
    'whitenoise.worker.active',
    { description: 'Busy non-retiring worker slots' }
  );
  const utilization: ObservableGauge = m.createObservableGauge(
    'whitenoise.worker.utilization',
    { description: 'active / pool.size (0-1)' }
  );

  m.addBatchObservableCallback(
    (result: BatchObservableResult) => {
      if (!poolCallbacks) return;
      const depth = poolCallbacks.queueDepth();
      const size = poolCallbacks.poolSize();
      const busy = poolCallbacks.activeWorkers();
      result.observe(queueDepth, depth);
      result.observe(poolSize, size);
      result.observe(active, busy);
      result.observe(utilization, size > 0 ? busy / size : 0);
    },
    [queueDepth, poolSize, active, utilization]
  );
}

export type DownstreamGaugeCallbacks = {
  connectedServers: () => Array<{ server: string; connected: number }>;
};

let downstreamGaugesRegistered = false;
let downstreamCallbacks: DownstreamGaugeCallbacks | null = null;

export function registerDownstreamGauges(
  callbacks: DownstreamGaugeCallbacks
): void {
  downstreamCallbacks = callbacks;
  if (downstreamGaugesRegistered) return;
  downstreamGaugesRegistered = true;
  const m = getMeter();
  const connected = m.createObservableGauge(
    'whitenoise.downstream.connected',
    { description: '1 if server connected, else 0' }
  );
  m.addBatchObservableCallback(
    (result: BatchObservableResult) => {
      if (!downstreamCallbacks) return;
      for (const row of downstreamCallbacks.connectedServers()) {
        result.observe(connected, row.connected, { server: row.server });
      }
    },
    [connected]
  );
}

export function recordExecutionDuration(
  durationMs: number,
  outcome: Outcome
): void {
  ensureInstruments().executionDuration.record(durationMs, { outcome });
}

export function recordQueueWait(durationMs: number): void {
  ensureInstruments().executionQueueWait.record(durationMs);
}

export function recordExecutionCount(outcome: Outcome): void {
  ensureInstruments().executionCount.add(1, { outcome });
}

export function recordExecutionTimeout(): void {
  ensureInstruments().executionTimeouts.add(1);
}

export function recordQueueFull(): void {
  ensureInstruments().executionQueueFull.add(1);
}

export function recordOutputTruncated(): void {
  ensureInstruments().executionOutputTruncated.add(1);
}

export function recordToolCall(
  durationMs: number,
  attrs: { server: string; tool: string; outcome: Outcome }
): void {
  const i = ensureInstruments();
  i.toolCallDuration.record(durationMs, attrs);
  i.toolCallCount.add(1, attrs);
}

export function recordWorkerRecycle(reason: RecycleReason): void {
  ensureInstruments().workerRecycleCount.add(1, { reason });
}

export function recordWorkerRun(): void {
  ensureInstruments().workerRunCount.add(1);
}

export function recordBundleCacheHit(): void {
  ensureInstruments().bundleCacheHit.add(1);
}

export function recordBundleCacheMiss(): void {
  ensureInstruments().bundleCacheMiss.add(1);
}

export function recordSearchDuration(
  durationMs: number,
  fallback: boolean
): void {
  ensureInstruments().searchDuration.record(durationMs, {
    fallback: String(fallback),
  });
}

export function recordSearchZeroMatch(): void {
  ensureInstruments().searchZeroMatchCount.add(1);
}

export function recordDiscoveryBytes(
  bytes: number,
  metaTool: string
): void {
  ensureInstruments().contextDiscoveryBytes.record(bytes, {
    meta_tool: metaTool,
  });
}

export function recordExecutionToolCalls(count: number, outcome: Outcome): void {
  ensureInstruments().executionToolCalls.record(count, { outcome });
}

export function recordRoundTripsAvoided(count: number): void {
  ensureInstruments().executionRoundTripsAvoided.record(count);
}

export function recordCatalogRefreshDuration(durationMs: number): void {
  ensureInstruments().catalogRefreshDuration.record(durationMs);
}

export function recordCatalogFailedServers(count: number): void {
  if (count > 0) {
    ensureInstruments().catalogRefreshFailedServers.add(count);
  }
}

export function recordCatalogRefreshCoalesced(): void {
  ensureInstruments().catalogRefreshCoalesced.add(1);
}

export function recordWrapperGenerated(fileCount: number): void {
  ensureInstruments().wrapperGeneratedCount.add(fileCount);
}

export function recordDownstreamReconnect(
  server: string,
  outcome: 'success' | 'failure' | 'gave_up'
): void {
  ensureInstruments().downstreamReconnectCount.add(1, { server, outcome });
}

export function recordModuleRead(): void {
  ensureInstruments().modulesRead.add(1);
}
