# SigNoz Observability Guide for WhiteNoise Experiments

## Quick Start

```bash
# Start SigNoz
cd /mnt/c/Users/Dhyaneesh/whitenoise/observability/pours/deployment
docker compose up -d

# Verify it's running
curl http://localhost:8080/api/v1/health
```

Open http://localhost:8080 in your browser.
Login: `admin@example.com` / `signoz`

---

## What to Look For During Tests

### 1. Trace List (Main Dashboard)

Navigate to **Traces** → Filter by `service.name = whitenoise-mcp`

You should see one trace per Claude prompt. Each trace contains:

| Span Name | Description | Expected Duration |
|-----------|-------------|-------------------|
| `whitenoise.downstream.connection` | MCP server spawning | 15-40s cold, <1s warm |
| `whitenoise.downstream.reconnect` | Retry after failure | 1-5s per attempt |
| `wrapper-execute` | The `execute_code` worker | 5-60s depending on tier |
| `tool-call` | Individual MCP tool invocation | Varies by tool |
| `http-request` | External API call (Brave, GitHub) | 200-800ms |
| `db-query` | SQLite/Postgres query | <10ms local |

### 2. Single Trace Deep Dive

Click any trace to see the flame graph. For a Hard tier test, expect:

```
whitenoise.mcp.request (30s total)
├── whitenoise.downstream.connection: braveSearch (25s cold boot)
├── whitenoise.downstream.connection: github (20s cold boot)
├── whitenoise.downstream.connection: puppeteer (35s cold boot - Chromium download)
├── whitenoise.downstream.connection: sqlite (<1s)
├── whitenoise.downstream.connection: postgres (<1s)
├── whitenoise.downstream.connection: filesystem (<1s)
├── whitenoise.downstream.connection: git (<1s)
├── whitenoise.downstream.connection: sequentialThinking (<1s)
└── wrapper-execute (15s)
    ├── tool-call: search (800ms)
    ├── tool-call: searchRepositories (600ms)
    ├── tool-call: navigate (2s)
    ├── tool-call: evaluate (500ms)
    ├── tool-call: query (5ms)
    ├── tool-call: query (5ms)
    ├── tool-call: readFile (2ms)
    ├── tool-call: git_log (10ms)
    └── tool-call: sequentialThinking (100ms x 5 steps)
```

### 3. Metrics Dashboard

Go to **Metrics** → Add these queries:

**Downstream Server Health:**
```
whitenoise_downstream_connected{server="braveSearch"}
whitenoise_downstream_connected{server="github"}
whitenoise_downstream_connected{server="puppeteer"}
```

**Error Rate:**
```
rate(whitenoise_errors_total[5m])
```

**Request Latency (p99):**
```
histogram_quantile(0.99, rate(whitenoise_request_duration_seconds_bucket[5m]))
```

### 4. Alerts (Optional)

Set up alerts for:
- `whitenoise_downstream_connected == 0` for >30s (server down)
- `rate(whitenoise_errors_total[5m]) > 0.1` (high error rate)
- `histogram_quantile(0.99, rate(whitenoise_request_duration_seconds_bucket[5m])) > 60` (slow requests)

---

## Per-Test Observability Checklist

After each test, record these observations:

### Easy Tier
- [ ] E1: `braveSearch` span shows external API call
- [ ] E1: `sqlite` spans show DB writes then reads
- [ ] E2: `git` span shows commit history query
- [ ] E2: `filesystem` spans show file reads
- [ ] E3: `puppeteer` span shows navigation + evaluate
- [ ] E3: No error spans in any Easy test

### Medium Tier
- [ ] M1: ≥6 downstream connection spans in one trace
- [ ] M1: `sequentialThinking` spans show reasoning steps
- [ ] M2: `github` span shows issue search
- [ ] M2: `context7` span appears (or error span if no creds)
- [ ] M3: `sqlite` → `postgres` migration shown as sequential tool calls
- [ ] M3: Row count verification query appears

### Hard Tier
- [ ] H1: ≥8 downstream connection spans in one trace
- [ ] H1: `braveSearch` and `github` run in parallel (same start time in flame graph)
- [ ] H1: `sqlite` and `postgres` show identical data writes
- [ ] H2: `git` spans show multiple commit queries
- [ ] H2: `braveSearch` → `puppeteer` chain visible (search result feeds into navigate)
- [ ] H3: `github` spans show repo metadata extraction
- [ ] H3: `filesystem` spans show local project reads

### Hell Mode
- [ ] X1: All 10 MCPs appear in connection spans
- [ ] X1: If `context7` or `chromeDevtools` fail, `error=true` span is child of `wrapper-execute` but trace continues
- [ ] X1: `wrapper-execute` contains ≥15 tool-call spans
- [ ] X1: Trace duration 3-8 minutes total
- [ ] X1: No `whitenoise.mcp.request` error span (top-level request succeeded despite partial failures)

---

## Debugging Failed Traces

### Red Error Spans

Click the red span → **Tags** → look for:
- `error.type`: What kind of failure
- `error.message`: Human-readable error
- `mcp.server.name`: Which MCP failed

Common failures:

| Error | Likely Cause | Resolution |
|-------|-------------|------------|
| `DownstreamUnavailableError` | MCP crashed or never started | Check server logs, restart Claude |
| `ENOENT` | Wrong file path | Model used Windows paths |
| `UNAUTHENTICATED` | Missing API token | Add env var to Claude config |
| `ETIMEDOUT` | External API slow | Retry, or check connectivity |
| `Navigation timeout` | Puppeteer page load slow | Increase timeout or use simpler URL |
| `Connection refused` | Postgres/SigNoz not running | Start docker containers |

### Missing Traces

If no traces appear:
1. Check `OTEL_EXPORTER_OTLP_ENDPOINT` is `http://localhost:4318`
2. Verify SigNoz collector is listening: `docker logs signoz-otel-collector`
3. Check if traces are sampled: look for `OTEL_TRACES_SAMPLER=always_on`

---

## Exporting Results

After all tests, export trace data:

```bash
# Export as JSON
curl "http://localhost:8080/api/v1/traces?service=whitenoise-mcp&start=...&end=..." > traces.json

# Or screenshot the flame graph from the UI for documentation
```

---

## Performance Benchmarks

Record these numbers across tiers to establish baselines:

| Metric | Easy | Medium | Hard | Hell |
|--------|------|--------|------|------|
| Total trace duration | 30-60s | 60-120s | 120-300s | 180-480s |
| Cold boot time (first npx) | 15-40s | 15-40s | 15-40s | 15-40s |
| Warm boot time (subsequent) | <1s | <1s | <1s | <1s |
| Worker execution time | 5-15s | 15-30s | 30-60s | 60-120s |
| Tools called per prompt | 3-5 | 6-10 | 10-20 | 15-30 |
| External API calls | 1-2 | 2-4 | 3-6 | 4-8 |

If your numbers are significantly higher, investigate:
- Network latency (WSL → Windows → internet)
- Docker resource limits
- npx cache misses
- Puppeteer Chromium downloads
