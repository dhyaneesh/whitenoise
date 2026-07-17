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

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP base URL (paths `/v1/traces` and `/v1/metrics` are appended) |
| `OTEL_SERVICE_NAME` | `whitenoise` | Resource `service.name` |
| `DEPLOYMENT_ENVIRONMENT` | `development` | Resource `deployment.environment.name` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `10000` | Metric export interval (ms) |

## Benchmark note (discovery bytes)

`search_tools` / `read_module` / `execute_code` are separate MCP calls with no shared task ID. Per-call discovery bytes are accurate; summing discovery across a multi-step agent task requires an external benchmark harness (for example under `dashboard/`).
