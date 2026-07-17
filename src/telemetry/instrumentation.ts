/**
 * OpenTelemetry bootstrap — must be loaded before application code via:
 *   node --import ./dist/telemetry/instrumentation.js dist/index.js
 *
 * Uses network OTLP exporters only (never console / stdout) so MCP stdio
 * traffic stays clean. Does NOT install SIGTERM/SIGINT handlers; the app
 * calls shutdownTelemetry() from its existing cleanup path.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'whitenoise',
  [ATTR_SERVICE_VERSION]: '0.1.0',
  'service.namespace': 'mcp',
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
    process.env.DEPLOYMENT_ENVIRONMENT ?? 'development',
});

const traceExporter = new OTLPTraceExporter({
  url: `${OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
});

const metricExporter = new OTLPMetricExporter({
  url: `${OTLP_ENDPOINT.replace(/\/$/, '')}/v1/metrics`,
});

const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: Number(
      process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 10_000
    ),
  }),
  textMapPropagator: new W3CTraceContextPropagator(),
});

let started = false;

try {
  sdk.start();
  started = true;
  // Diagnostics only on stderr — never stdout (MCP wire protocol).
  console.error(
    `[telemetry] OpenTelemetry started → ${OTLP_ENDPOINT} (service=whitenoise)`
  );
} catch (err) {
  console.error('[telemetry] failed to start OpenTelemetry SDK:', err);
}

export async function shutdownTelemetry(): Promise<void> {
  if (!started) return;
  try {
    await sdk.shutdown();
    console.error('[telemetry] OpenTelemetry shut down');
  } catch (err) {
    console.error('[telemetry] shutdown error:', err);
  } finally {
    started = false;
  }
}
