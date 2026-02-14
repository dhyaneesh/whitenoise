# WhiteNoise Benchmark Dashboard

Live benchmark UI comparing **WhiteNoise** vs **vanilla MCP** on context size, latency, round-trips, and tokens transferred.

The dashboard runs **two LangChain-JS (LangGraph) agents**:

1. **Vanilla MCP agent** — ReAct agent with all downstream MCP tools in context.
2. **WhiteNoise agent** — ReAct agent with the four meta-tools: `search_tools`, `list_modules`, `read_module`, `execute_code`.

Both use `@langchain/langgraph` prebuilt `createReactAgent` and `@langchain/google-genai` (Gemini). Cost and token usage can be tracked in [LangSmith](https://docs.langchain.com/langsmith/cost-tracking) when tracing is enabled.

## Prerequisites

- Node.js 20+
- WhiteNoise project built: from repo root run `npm run build`

## Run the dashboard

From this directory (`dashboard/`):

```bash
npm run dev
```

This builds the parent WhiteNoise project (if needed), starts the API server on **http://localhost:3001**, and the Vite dev server (with proxy to the API). Open the URL Vite prints (e.g. http://localhost:5173).

**Real LLM comparison:** The "Real LLM comparison" section uses the Google Gemini API. Set `GEMINI_API_KEY` in the environment when starting the server (e.g. `GEMINI_API_KEY=your-key npm run dev` or export it in your shell). You can get an API key from [Google AI Studio](https://aistudio.google.com/apikey).

**LangSmith cost tracking (optional):** To send traces and token/cost data to LangSmith, set:

- `LANGSMITH_TRACING=true`
- `LANGSMITH_API_KEY=your-langsmith-api-key`

Runs for the Vanilla and WhiteNoise agents will include `usage_metadata` (input/output tokens) and `ls_provider` / `ls_model_name` for cost calculation in the [LangSmith UI](https://smith.langchain.com). See [Cost tracking](https://docs.langchain.com/langsmith/cost-tracking) for details.

## Run frontend only (API already running)

```bash
npm run dev:frontend
```

## Run API server only

From repo root, ensure WhiteNoise is built (`npm run build`), then:

```bash
cd dashboard && npm run dev:server
```

The server boots WhiteNoise (downstream pool, catalog, wrappers, execution manager) and exposes:

- `GET /api/benchmark/scenarios` — list benchmark scenarios
- `GET /api/benchmark/context` — context window comparison (vanilla vs WhiteNoise tokens)
- `POST /api/benchmark/run` — body `{ "scenarioId": "string" }` — run one scenario
- `POST /api/benchmark/run-all` — run all scenarios
- `POST /api/llm/run-vanilla` — body `{ "task": "string", "model"?: "string" }` — Vanilla MCP agent (LangGraph)
- `POST /api/llm/run-whitenoise` — body `{ "task": "string", "model"?: "string" }` — WhiteNoise agent (LangGraph)

## Build for production

```bash
npm run build
```

This builds only the frontend. The API server is run with `tsx server/index.ts` and expects the parent WhiteNoise `dist/` to exist.
