// src/telemetry/tracing.ts
import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

const TRACER_NAME = 'whitenoise';

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, '0.1.0');
}

export function getActiveContext(): Context {
  return context.active();
}

export function withContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}

export async function withSpan<T>(
  name: string,
  attrs: Attributes | undefined,
  fn: (span: Span) => Promise<T> | T
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      recordException(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export function recordException(span: Span, err: unknown): void {
  if (err instanceof Error) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  } else {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: String(err),
    });
  }
}

export function startChildSpan(
  name: string,
  parentCtx: Context,
  attrs?: Attributes,
  startTime?: number
): Span {
  const tracer = getTracer();
  return tracer.startSpan(
    name,
    {
      attributes: attrs,
      startTime: startTime !== undefined ? startTime : undefined,
    },
    parentCtx
  );
}

export function contextWithSpan(parent: Context, span: Span): Context {
  return trace.setSpan(parent, span);
}
