# WhiteNoise Observability (OpenTelemetry + SigNoz)

WhiteNoise is a **stdio MCP proxy**. stdout is reserved for the MCP wire protocol.
Telemetry is exported over the network via OTLP/HTTP only — never to stdout or a console exporter.

## Prerequisites

- Docker Engine 20.10+ with Compose v2 (or Docker Desktop)
- At least 4 GB RAM for SigNoz
- Node.js 20+
- Linux or macOS for SigNoz Foundry (Windows is not officially supported; use WSL2)

## 1. Start SigNoz (self-hosted via Foundry)

SigNoz deprecated the old `deploy/docker` Compose bundle. Use [Foundry](https://signoz.io/docs/install/docker/):

```bash
curl -fsSL https://signoz.io/foundry.sh | bash

# From this folder (or copy casting.yaml elsewhere):
foundryctl cast -f casting.yaml
```

A sample casting file is in [`casting.yaml`](./casting.yaml).

After cast completes:

| Endpoint | URL |
|----------|-----|
| UI | http://localhost:8080 |
| OTLP HTTP | http://localhost:4318 |
| OTLP gRPC | http://localhost:4317 |

No ingestion key is required for self-hosted SigNoz.

### Prefer managing Compose yourself

```bash
foundryctl gauge -f casting.yaml
foundryctl forge -f casting.yaml
cd pours/deployment && docker compose up -d
```

## 2. Run WhiteNoise with telemetry

```bash
npm run build
# Optional overrides:
#   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
#   OTEL_SERVICE_NAME=whitenoise
#   DEPLOYMENT_ENVIRONMENT=development
npm start
```

`npm start` loads the SDK before app code:

```text
node --import ./dist/telemetry/instrumentation.js dist/index.js
```

On shutdown, `index.ts` calls `shutdownTelemetry()` after stopping the execution manager and downstream pool (no competing SIGTERM handlers in the SDK).

## 3. Confirm traces in SigNoz

1. Open http://localhost:8080
2. Go to **Services** — you should see `whitenoise`
3. Trigger meta-tools (`search_tools`, `read_module`, `execute_code`)
4. Open **Traces** and look for `mcp.server execute_code` with children:
   - `whitenoise.queue.wait`
   - `whitenoise.execution.run`
   - cache / rebuild stages (on miss)
   - `whitenoise.execution.user_code`
   - `mcp.client <server>/<tool>`

## Privacy defaults

Spans and metrics record **sizes, hashes, counts, and outcomes** — not raw source code, tool arguments, or results.

## Dashboard templates

JSON panel catalogs live in [`dashboards/`](./dashboards/). Recreate them in the SigNoz UI (**Dashboards → New**) using the metric names listed, or adapt the JSON to SigNoz’s current import format.

1. [MCP Proxy Health](./dashboards/mcp-proxy-health.json)
2. [Downstream MCP Servers](./dashboards/downstream-mcp-servers.json)
3. [WhiteNoise Efficiency](./dashboards/whitenoise-efficiency.json)
4. [WhiteNoise SLOs](./dashboards/whitenoise-slos.json)

## Metrics catalog

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `whitenoise.execution.duration` | histogram | outcome | execute_code wall duration |
| `whitenoise.execution.count` | counter | outcome | Runs by outcome |
| `whitenoise.execution.queue_wait` | histogram | — | Queue wait time |
| `whitenoise.tool_call.duration` | histogram | server, tool, outcome | Downstream call latency |
| `whitenoise.tool_call.count` | counter | server, tool, outcome | Downstream call count |
| `whitenoise.tool_call.result.bytes` | histogram | server, tool | Result size |
| `whitenoise.tool_call.arguments.bytes` | histogram | server, tool | Arguments size |
| `whitenoise.tool_call.oversize.count` | counter | server, tool | Results exceeding maxResultBytes |
| `whitenoise.downstream.connection.duration` | histogram | server, outcome | Connection setup time |
| `whitenoise.downstream.connection.count` | counter | server, outcome | Connection attempts |
| `whitenoise.downstream.reconnect.count` | counter | server, outcome | Reconnect attempts |
| `whitenoise.downstream.connected` | gauge | server | 1 if connected |
| `whitenoise.wrapper.generation.count` | counter | generation_id, outcome | Generation publications |
| `whitenoise.wrapper.generation.duration` | histogram | generation_id, outcome | Generation publish time |
| `whitenoise.wrapper.swap.count` | counter | reason | Swaps (startup\|hot_reload) |
| `whitenoise.catalog.degraded` | gauge | server | 1 if entries are last-known-good |
| `whitenoise.error.count` | counter | layer, type, server?, tool? | Errors — never raw message |

## SLO definitions

WhiteNoise distinguishes **platform failures** (infrastructure problems the model/user cannot fix) from **user/model errors** (bad code, invalid input):

| SLI | Calculation | Example types |
|-----|-------------|---------------|
| **Platform availability** | `1 - error.count{layer∈(proxy,exec,downstream), type∉(COMPILATION_ERROR,MODULE_NOT_FOUND,INPUT_VALIDATION_ERROR)} / execution.count` | `DOWNSTREAM_UNAVAILABLE`, `WORKER_CRASH`, `EXECUTION_TIMEOUT`, `QUEUE_FULL`, `auth_failed`, `reconnect_failed` |
| **User-error rate** | `error.count{type∈(COMPILATION_ERROR,MODULE_NOT_FOUND,RUNTIME_ERROR)} / execution.count` | `COMPILATION_ERROR`, `RUNTIME_ERROR` |

Suggested SLO targets:
- Platform availability ≥ 99.5% over 5-minute windows
- User-error rate: informational (not an SLO — reflects model code quality, not proxy health)

### Example SigNoz queries

```promql
# Platform error rate
sum(rate(whitenoise_error_count_total{layer!="catalog",type!~"COMPILATION_ERROR|MODULE_NOT_FOUND|INPUT_VALIDATION_ERROR"}[5m]))
  /
sum(rate(whitenoise_execution_count_total[5m]))

# Per-server downstream connection outcomes
sum by (server, outcome) (rate(whitenoise_downstream_connection_count_total[5m]))

# Wrapper generation health
sum by (outcome) (rate(whitenoise_wrapper_generation_count_total[5m]))
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP base URL (paths `/v1/traces` and `/v1/metrics` are appended) |
| `OTEL_SERVICE_NAME` | `whitenoise` | Resource `service.name` |
| `DEPLOYMENT_ENVIRONMENT` | `development` | Resource `deployment.environment.name` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `10000` | Metric export interval (ms) |

## Benchmark note (discovery bytes)

`search_tools` / `read_module` / `execute_code` are separate MCP calls with no shared task ID. Per-call discovery bytes are accurate; summing discovery across a multi-step agent task requires an external benchmark harness (for example under `dashboard/`).
