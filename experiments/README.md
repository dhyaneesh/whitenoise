# WhiteNoise Real-World Experiment Suite

## Overview

This directory contains a **3-tier + Hell Mode** test suite for WhiteNoise. Each test is a **natural language prompt** given to the model. The model must figure out which MCPs to use, discover their wrappers via `search_tools`, read their types via `read_module`, and compose them in `execute_code`.

**Goal:** Prove WhiteNoise can orchestrate **3-10 MCPs in a single `execute_code` call** with real multi-hop reasoning, data transformation, and error handling.

---

## Prerequisites

### 1. Environment Variables (add to Claude Desktop MCP config)

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxxxxxx",
    "BRAVE_API_KEY": "BSxxxxxxxxxxxxxxxx",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    "OTEL_SERVICE_NAME": "whitenoise-mcp"
  }
}
```

- **GitHub Token:** https://github.com/settings/tokens → `repo` scope
- **Brave API Key:** https://brave.com/search/api/ → free tier (1,000 queries/mo)

### 2. Infrastructure

```bash
# Postgres for DB tests
docker run -d --name whitenoise-postgres \
  -e POSTGRES_DB=whitenoise_test \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:15

# SigNoz for observability
cd /mnt/c/Users/Dhyaneesh/whitenoise/observability/pours/deployment
docker compose up -d
```

SigNoz UI: http://localhost:8080 (admin@example.com / signoz)

### 3. Build WhiteNoise

```bash
cd /mnt/c/Users/Dhyaneesh/whitenoise
npm run build
```

Then **restart Claude Desktop** to pick up the new build.

---

## How to Run a Test

1. Open Claude Desktop
2. Paste the prompt from `prompts.md` (choose your tier)
3. **Do not help the model.** Let it discover tools on its own.
4. Wait for it to finish (Easy: 30-60s, Medium: 60-120s, Hard: 2-5min, Hell: 3-8min)
5. Run the validation script:
   ```bash
   cd /mnt/c/Users/Dhyaneesh/whitenoise/experiments
   ./validate.sh
   ```

---

## What to Watch For

### Model Behavior (Success Criteria)

| Behavior | Good Sign | Bad Sign |
|----------|-----------|----------|
| **Discovery** | Uses `search_tools` first to find relevant wrappers | Skips discovery, guesses tool names |
| **Type Safety** | Uses `read_module` to verify argument shapes | Guesses arguments, gets type errors |
| **Composition** | Single `execute_code` chains 3+ MCP imports | Multiple round-trip `execute_code` calls |
| **Reasoning** | Uses `sequentialThinking` for planning complex tasks | No planning, just brute-forces tools |
| **Error Handling** | Catches failures, continues with remaining tools | Crashes on first error |
| **Path Correctness** | Uses `/mnt/c/...` paths | Uses `C:\` Windows paths |

### SigNoz Observability Checklist

Open http://localhost:8080 → **Traces** → Filter `service.name = "whitenoise-mcp"`

For each test, verify:
- [ ] Trace appears within 5 seconds of prompt
- [ ] `whitenoise.downstream.connection` spans show all relevant MCPs booting
- [ ] `wrapper-execute` span contains nested `tool-call` spans
- [ ] No red error spans (or if there are, they were caught and handled)
- [ ] For web tools: `tool-call` shows external latency (~200-800ms)
- [ ] For DB tools: `tool-call` shows local latency (<10ms)
- [ ] For sequential thinking: `tool-call` spans show reasoning steps
- [ ] Total trace duration is reasonable (not hanging)

### Metrics to Collect

| Metric | Where to Find |
|--------|---------------|
| Cold boot time | First `downstream.connection` span per MCP |
| Warm reuse time | Subsequent `downstream.connection` spans |
| Worker execution time | `wrapper-execute` span duration |
| Error rate | Traces with `error=true` spans |
| Tools per prompt | Count of `tool-call` spans under `wrapper-execute` |

---

## Tier Summary

| Tier | Tests | MCPs per Test | Duration | Complexity |
|------|-------|---------------|----------|------------|
| **Easy** | 3 | 3 | 30-60s | Sequential chains |
| **Medium** | 3 | 5-6 | 60-120s | Branching + reasoning |
| **Hard** | 3 | 7-9 | 2-5min | Multi-hop reasoning, DB sync, research |
| **Hell** | 1 | 10 | 3-8min | Everything + fault tolerance |

---

## Scoring

After running all 10 tests, score WhiteNoise:

| Criteria | Weight | Pass Threshold |
|----------|--------|----------------|
| Tool Discovery | 20% | Model used `search_tools` in ≥8/10 tests |
| Type Verification | 15% | Model used `read_module` in ≥7/10 tests |
| Multi-MCP Composition | 25% | Single `execute_code` used ≥3 MCPs in ≥7/10 tests |
| Sequential Reasoning | 15% | Model used `sequentialThinking` in ≥4/10 tests |
| Error Resilience | 15% | Gracefully handled ≥2 tool failures |
| Observability | 10% | All 10 traces visible in SigNoz with no unhandled errors |

**90%+ = Production Ready**
**70-89% = Good, minor fixes needed**
**50-69% = Usable but needs work**
**<50% = Significant issues**

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| Model says "no tools found" | `search_tools` query too specific | Model should try broader queries |
| `ENOENT` on file paths | Model used Windows paths | System prompt reminds about `/mnt/c/` |
| `DownstreamUnavailableError` | MCP failed to start | Check docker/dependencies running |
| `UNAUTHENTICATED` on GitHub | Missing `GITHUB_PERSONAL_ACCESS_TOKEN` | Add to Claude Desktop config env |
| `UNAUTHENTICATED` on Brave | Missing `BRAVE_API_KEY` | Add to Claude Desktop config env |
| Trace missing in SigNoz | OTEL endpoint wrong | Verify `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Puppeteer times out | Browser download slow | First run takes ~60s to download Chromium |
| Postgres connection refused | Docker container not running | `docker start whitenoise-postgres` |
| Chrome devtools fails | Chrome not running with remote debug | Optional — test continues without it |

---

## File Structure

```
experiments/
├── README.md           # This file — setup and guide
├── prompts.md          # All test prompts by tier
├── validate.sh         # Bash script to check outputs
└── signoz-dashboard.md # How to read SigNoz traces
```
