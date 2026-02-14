/**
 * Two LangChain-JS (LangGraph) agents: Vanilla MCP and WhiteNoise.
 * Uses createReactAgent with ChatGoogleGenerativeAI. LangSmith cost tracking
 * is enabled via env (LANGSMITH_TRACING, LANGSMITH_API_KEY) and usage_metadata.
 * @see https://docs.langchain.com/langsmith/cost-tracking
 */

import { tool } from '@langchain/core/tools';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { traceable, getCurrentRunTree } from 'langsmith/traceable';

/* --------------------------------------------------------------------------- */
/* Types for pool, catalog, execMgr, modules                                   */
/* --------------------------------------------------------------------------- */

export type PoolLike = {
  getClient: (name: string) => {
    callTool: (req: { name: string; arguments?: unknown }) => Promise<{ content?: unknown[]; isError?: boolean }>;
  };
};

export type CatalogLike = {
  listAll: () => Array<{ fqTool: string; description?: string; inputSchemaRaw?: unknown }>;
  search: (query: string, limit?: number) => Array<{ fqTool: string; tool: string; description?: string }>;
};

export type ExecMgrLike = {
  execute: (script: string, opts?: { timeoutMs?: number }) => Promise<{ durationMs: number; stdout: string; stderr: string }>;
};

export type ModulesLike = {
  listModules: (path?: string) => Promise<string[]>;
  readModule: (specifier: string) => Promise<string>;
};

export type LLMRunResult = {
  ok: boolean;
  latencyMs: number;
  roundTrips: number;
  promptTokens: number;
  completionTokens: number;
  finalMessage: string | null;
  error?: string;
  messageCount: number;
};

const DEFAULT_MODEL = 'gemini-2.5-flash';

function parseFqTool(fqTool: string): { server: string; tool: string } {
  const idx = fqTool.indexOf('__');
  if (idx === -1) throw new Error(`Invalid fqTool: ${fqTool}`);
  return { server: fqTool.slice(0, idx), tool: fqTool.slice(idx + 2) };
}

function mcpResultToContent(result: { content?: unknown[]; isError?: boolean }): string {
  if (result.isError) return JSON.stringify(result);
  if (Array.isArray(result.content)) {
    return result.content
      .map((c: unknown) =>
        typeof c === 'object' && c !== null && 'text' in c ? (c as { text: string }).text : JSON.stringify(c),
      )
      .join('\n');
  }
  return JSON.stringify(result);
}

/* --------------------------------------------------------------------------- */
/* Vanilla MCP: LangChain tools from catalog                                   */
/* --------------------------------------------------------------------------- */

function buildVanillaTools(pool: PoolLike, catalog: CatalogLike) {
  const entries = catalog.listAll();
  return entries.map((e) => {
    const { server, tool: toolName } = parseFqTool(e.fqTool);
    return tool(
      async (args: Record<string, unknown>) => {
        const client = pool.getClient(server);
        const result = await client.callTool({ name: toolName, arguments: args });
        return mcpResultToContent(result);
      },
      {
        name: e.fqTool,
        description: e.description ?? e.fqTool,
        schema: z.record(z.unknown()),
      },
    );
  });
}

/* --------------------------------------------------------------------------- */
/* WhiteNoise: 4 meta-tools                                                     */
/* --------------------------------------------------------------------------- */

function buildWhiteNoiseTools(
  catalog: CatalogLike,
  execMgr: ExecMgrLike,
  modules: ModulesLike,
) {
  const searchTools = tool(
    async ({ query, limit }: { query: string; limit?: number }) => {
      const results = catalog.search(query, limit ?? 20);
      return JSON.stringify({ query, count: results.length, results });
    },
    {
      name: 'search_tools',
      description:
        'Search the downstream tool catalog by name or description. Each result includes a specifier you can pass to read_module to get the wrapper source.',
      schema: z.object({
        query: z.string().describe('Search term'),
        limit: z.number().optional().describe('Max results (default 20)'),
      }),
    },
  );

  const listModules = tool(
    async ({ path: pathArg }: { path?: string }) => {
      const list = await modules.listModules(pathArg ?? '');
      return JSON.stringify(list);
    },
    {
      name: 'list_modules',
      description:
        'List wrapper module specifiers. Use when search_tools does not find what you need (fallback for full context).',
      schema: z.object({
        path: z.string().optional().describe('Sub-path within wrappers (optional)'),
      }),
    },
  );

  const readModule = tool(
    async ({ specifier }: { specifier: string }) => {
      const source = await modules.readModule(specifier);
      return JSON.stringify({ source });
    },
    {
      name: 'read_module',
      description:
        'Return the source code of a wrapper module. Use the specifier from search_tools results (or from list_modules).',
      schema: z.object({
        specifier: z.string().describe('Module specifier from search_tools or list_modules'),
      }),
    },
  );

  const executeCode = tool(
    async ({ code, timeoutMs }: { code: string; timeoutMs?: number }) => {
      const result = await execMgr.execute(code, { timeoutMs: timeoutMs ?? 30000 });
      return JSON.stringify({ durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr });
    },
    {
      name: 'execute_code',
      description:
        "Execute TypeScript code that imports wrappers and calls downstream tools. Use specifiers from read_module; e.g. import { echo } from 'mcp/servers/everything/echo'; then await echo({ message: 'hi' });",
      schema: z.object({
        code: z.string().describe('TypeScript source to execute'),
        timeoutMs: z.number().optional().describe('Timeout in ms (default 30000)'),
      }),
    },
  );

  return [searchTools, listModules, readModule, executeCode];
}

/* --------------------------------------------------------------------------- */
/* Agent runners with LangSmith cost tracking                                  */
/* --------------------------------------------------------------------------- */

const VANILLA_SYSTEM = `You have access to MCP tools. Use them to complete the user's task. Tool names are fully-qualified (e.g. everything__echo, memory__create_entity). Call tools when needed, then summarize the result for the user.`;

const WHITENOISE_SYSTEM = `You have 4 meta-tools:
1. search_tools(query, limit?) — Search for downstream tools. Each result includes a specifier. Use that specifier in read_module to get the full wrapper source.
2. read_module(specifier) — Return the source of a wrapper. Use the specifier from search_tools results.
3. execute_code(code, timeoutMs?) — Run TypeScript that imports wrappers (from the specifiers you got) and calls the tools. Use read_module output to see exact imports and usage.
4. list_modules(path?) — Fallback: list all wrapper specifiers when search_tools does not give you what you need.

Flow: search_tools → read_module(specifier from results) → execute_code. Use list_modules only when search is insufficient. Complete the user's task.`;

function extractUsageFromMessages(messages: BaseMessage[]): { promptTokens: number; completionTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const msg of messages) {
    const aim = msg as AIMessage & { response_metadata?: Record<string, unknown>; usage_metadata?: Record<string, unknown> };
    const meta =
      aim.additional_kwargs?.usage_metadata ??
      aim.usage_metadata ??
      aim.response_metadata?.usage_metadata ??
      (aim as unknown as { usage_metadata?: Record<string, unknown> }).usage_metadata;
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>;
      promptTokens += Number(m.prompt_token_count ?? m.input_tokens ?? m.promptTokenCount ?? 0);
      completionTokens += Number(
        m.candidates_token_count ?? m.output_tokens ?? m.completion_tokens ?? m.candidatesTokenCount ?? 0,
      );
    }
  }
  return { promptTokens, completionTokens };
}

function getLastTextContent(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof (m as AIMessage).content === 'string' && (m as AIMessage).content) {
      return (m as AIMessage).content as string;
    }
  }
  return null;
}

function setRunTreeCostMetadata(usage: { promptTokens: number; completionTokens: number }, model: string): void {
  try {
    const runTree = getCurrentRunTree() as { extra?: { metadata?: Record<string, unknown> } };
    if (!runTree || (usage.promptTokens === 0 && usage.completionTokens === 0)) return;
    if (!runTree.extra) runTree.extra = {};
    runTree.extra.metadata = {
      ...runTree.extra.metadata,
      usage_metadata: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
      },
      ls_provider: 'google',
      ls_model_name: model,
    };
  } catch {
    // No active run tree (e.g. LangSmith tracing disabled)
  }
}

/**
 * Run the Vanilla MCP agent (LangGraph ReAct agent with all downstream tools).
 * LangSmith: set LANGSMITH_TRACING=true and LANGSMITH_API_KEY for cost tracking.
 * @see https://docs.langchain.com/langsmith/cost-tracking
 */
export const runVanillaAgent = traceable(
  async (
    task: string,
    pool: PoolLike,
    catalog: CatalogLike,
    apiKey: string,
    model: string = DEFAULT_MODEL,
  ): Promise<LLMRunResult> => {
    const start = Date.now();
    const llm = new ChatGoogleGenerativeAI({
      model,
      apiKey,
      temperature: 0,
      maxOutputTokens: 8192,
    });
    const tools = buildVanillaTools(pool, catalog);
    const agent = createReactAgent({
      llm,
      tools,
      prompt: VANILLA_SYSTEM,
    });

    try {
      const result = await agent.invoke({
        messages: [new HumanMessage(task)],
      });
      const messages = (result?.messages ?? []) as BaseMessage[];
      const usage = extractUsageFromMessages(messages);
      setRunTreeCostMetadata(usage, model);
      const finalMessage = getLastTextContent(messages);
      return {
        ok: true,
        latencyMs: Date.now() - start,
        roundTrips: Math.ceil(messages.length / 2),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        finalMessage,
        messageCount: messages.length,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        roundTrips: 0,
        promptTokens: 0,
        completionTokens: 0,
        finalMessage: null,
        error: err instanceof Error ? err.message : String(err),
        messageCount: 0,
      };
    }
  },
  { name: 'run_vanilla_agent', run_type: 'chain' },
);

/**
 * Run the WhiteNoise agent (LangGraph ReAct agent with 4 meta-tools).
 * LangSmith: set LANGSMITH_TRACING=true and LANGSMITH_API_KEY for cost tracking.
 * @see https://docs.langchain.com/langsmith/cost-tracking
 */
export const runWhiteNoiseAgent = traceable(
  async (
    task: string,
    pool: PoolLike,
    catalog: CatalogLike,
    execMgr: ExecMgrLike,
    modules: ModulesLike,
    apiKey: string,
    model: string = DEFAULT_MODEL,
  ): Promise<LLMRunResult> => {
    const start = Date.now();
    const llm = new ChatGoogleGenerativeAI({
      model,
      apiKey,
      temperature: 0,
      maxOutputTokens: 8192,
    });
    const tools = buildWhiteNoiseTools(catalog, execMgr, modules);
    const agent = createReactAgent({
      llm,
      tools,
      prompt: WHITENOISE_SYSTEM,
    });

    try {
      const result = await agent.invoke({
        messages: [new HumanMessage(task)],
      });
      const messages = (result?.messages ?? []) as BaseMessage[];
      const usage = extractUsageFromMessages(messages);
      setRunTreeCostMetadata(usage, model);
      const finalMessage = getLastTextContent(messages);
      return {
        ok: true,
        latencyMs: Date.now() - start,
        roundTrips: Math.ceil(messages.length / 2),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        finalMessage,
        messageCount: messages.length,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        roundTrips: 0,
        promptTokens: 0,
        completionTokens: 0,
        finalMessage: null,
        error: err instanceof Error ? err.message : String(err),
        messageCount: 0,
      };
    }
  },
  { name: 'run_whitenoise_agent', run_type: 'chain' },
);
