import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SpanStatusCode, trace, context } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  withSpan,
  recordException,
  startChildSpan,
  contextWithSpan,
  getTracer,
  getActiveContext,
  withContext,
} from '../../src/telemetry/tracing.js';

describe('telemetry tracing', () => {
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it('withSpan returns the function result and records OK', async () => {
    const result = await withSpan(
      'test.ok',
      { custom: 'val' },
      async (span) => {
        span.setAttribute('inner', 1);
        return 42;
      }
    );
    expect(result).toBe(42);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test.ok');
    expect(spans[0].attributes['custom']).toBe('val');
    expect(spans[0].attributes['inner']).toBe(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it('withSpan records exception and rethrows on failure', async () => {
    await expect(
      withSpan('test.error', {}, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('recordException attaches exception event to span', () => {
    const span = getTracer().startSpan('exc.span');
    recordException(span, new Error('msg'));
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe('exception');
  });

  it('recordException handles non-Error values', () => {
    const span = getTracer().startSpan('exc.nonerr');
    recordException(span, 'plain string');
    span.end();

    const spans = exporter.getFinishedSpans();
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('plain string');
  });

  it('startChildSpan links to parent context', () => {
    const parent = getTracer().startSpan('parent');
    const parentCtx = contextWithSpan(context.active(), parent);
    const child = startChildSpan('child', parentCtx, { key: 'val' });
    child.end();
    parent.end();

    const spans = exporter.getFinishedSpans();
    const childSpan = spans.find((s) => s.name === 'child');
    expect(childSpan).toBeTruthy();
    expect(childSpan!.parentSpanContext!.spanId).toBe(
      parent.spanContext().spanId
    );
    expect(childSpan!.attributes['key']).toBe('val');
  });

  it('contextWithSpan and getActiveContext work together', () => {
    const span = getTracer().startSpan('ctx-test');
    const ctx = contextWithSpan(context.active(), span);
    expect(trace.getSpan(ctx)).toBe(span);

    const active = getActiveContext();
    // active should be root (no span set)
    expect(trace.getSpan(active)).toBeUndefined();
  });

  it('withContext runs function in provided context', () => {
    const span = getTracer().startSpan('wrapped');
    const ctx = contextWithSpan(context.active(), span);
    let captured: context.Context | null = null;
    withContext(ctx, () => {
      captured = context.active();
    });
    expect(trace.getSpan(captured!)).toBe(span);
  });
});
