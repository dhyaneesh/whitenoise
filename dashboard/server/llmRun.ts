import OpenAI from 'openai';
import { getVanillaTools, getWhiteNoiseTools, type OpenAITool } from './llmTools.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_ROUNDS = 15;

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

type PoolLike = {
  getClient: (name: string) => {
    callTool: (req: { name: string; arguments?: unknown }) => Promise<{ content?: unknown[]; isError?: boolean }>;
  };
};

type CatalogLike = {
  listAll: () => Array<{ fqTool: string; description?: string; inputSchemaRaw?: unknown }>;
  search: (query: string, limit?: number) => Array<{ fqTool: string; tool: string; description?: string }>;
};

type ExecMgrLike = {
  execute: (script: string, opts?: { timeoutMs?: number }) => Promise<{ durationMs: number; stdout: string; stderr: string }>;
};

type ModulesLike = {
  listModules: (path?: string) => Promise<string[]>;
  readModule: (specifier: string) => Promise<string>;
};

function parseFqTool(fqTool: string): { server: string; tool: string } {
  const idx = fqTool.indexOf('__');
  if (idx === -1) throw new Error(`Invalid fqTool: ${fqTool}`);
  return { server: fqTool.slice(0, idx), tool: fqTool.slice(idx + 2) };
}

function mcpResultToContent(result: { content?: unknown[]; isError?: boolean }): string {
  if (result.isError) return JSON.stringify(result);
  if (Array.isArray(result.content)) {
    return result.content
      .map((c: unknown) => (typeof c === 'object' && c !== null && 'text' in c ? (c as { text: string }).text : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(result);
}

export async function runVanilla(
  task: string,
  pool: PoolLike,
  catalog: CatalogLike,
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<LLMRunResult> {
  const openai = new OpenAI({ apiKey });
  const tools: OpenAITool[] = getVanillaTools(catalog.listAll());
  const start = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let roundTrips = 0;

  const systemPrompt = `You have access to MCP tools. Use them to complete the user's task. Tool names are fully-qualified (e.g. everything__echo, memory__create_entity). Call tools when needed, then summarize the result for the user.`;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await openai.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
      });

      const choice = response.choices[0];
      if (!choice?.message) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          roundTrips: round + 1,
          promptTokens,
          completionTokens,
          finalMessage: null,
          error: 'No message in response',
          messageCount: messages.length,
        };
      }

      const msg = choice.message;
      if (response.usage) {
        promptTokens += response.usage.prompt_tokens;
        completionTokens += response.usage.completion_tokens;
      }
      roundTrips++;

      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return {
          ok: true,
          latencyMs: Date.now() - start,
          roundTrips,
          promptTokens,
          completionTokens,
          finalMessage: typeof msg.content === 'string' ? msg.content : (msg.content ?? null) ? String(msg.content) : null,
          messageCount: messages.length,
        };
      }

      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function' || !tc.function) continue;
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        const { server, tool } = parseFqTool(name);
        const client = pool.getClient(server);
        const result = await client.callTool({ name: tool, arguments: args });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: mcpResultToContent(result),
        });
      }
    }

    return {
      ok: false,
      latencyMs: Date.now() - start,
      roundTrips,
      promptTokens,
      completionTokens,
      finalMessage: null,
      error: `Max rounds (${MAX_ROUNDS}) exceeded`,
      messageCount: messages.length,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      roundTrips,
      promptTokens,
      completionTokens,
      finalMessage: null,
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    };
  }
}

export async function runWhiteNoise(
  task: string,
  pool: PoolLike,
  catalog: CatalogLike,
  execMgr: ExecMgrLike,
  modules: ModulesLike,
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<LLMRunResult> {
  const openai = new OpenAI({ apiKey });
  const tools = getWhiteNoiseTools();
  const start = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let roundTrips = 0;

  const systemPrompt = `You have 4 meta-tools to work with downstream MCP tools:
1. search_tools(query, limit?) - search for tools by name/description
2. list_modules(path?) - list wrapper modules (e.g. mcp/servers/everything/echo)
3. read_module(specifier) - read a module's source to see its function signature
4. execute_code(code, timeoutMs?) - run TypeScript that imports from 'mcp/servers/...' and calls tools

To run multiple tools in one go, use execute_code with a script that imports and calls the wrappers. Complete the user's task.`;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await openai.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto',
      });

      const choice = response.choices[0];
      if (!choice?.message) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          roundTrips: round + 1,
          promptTokens,
          completionTokens,
          finalMessage: null,
          error: 'No message in response',
          messageCount: messages.length,
        };
      }

      const msg = choice.message;
      if (response.usage) {
        promptTokens += response.usage.prompt_tokens;
        completionTokens += response.usage.completion_tokens;
      }
      roundTrips++;

      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return {
          ok: true,
          latencyMs: Date.now() - start,
          roundTrips,
          promptTokens,
          completionTokens,
          finalMessage: typeof msg.content === 'string' ? msg.content : (msg.content ?? null) ? String(msg.content) : null,
          messageCount: messages.length,
        };
      }

      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function' || !tc.function) continue;
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }

        let content: string;
        switch (name) {
          case 'search_tools': {
            const query = typeof args.query === 'string' ? args.query : '';
            const limit = typeof args.limit === 'number' ? args.limit : 20;
            const results = catalog.search(query, limit);
            content = JSON.stringify({ query, count: results.length, results }, null, 2);
            break;
          }
          case 'list_modules': {
            const path = typeof args.path === 'string' ? args.path : '';
            const list = await modules.listModules(path);
            content = JSON.stringify(list, null, 2);
            break;
          }
          case 'read_module': {
            const specifier = typeof args.specifier === 'string' ? args.specifier : '';
            content = await modules.readModule(specifier);
            break;
          }
          case 'execute_code': {
            const code = typeof args.code === 'string' ? args.code : '';
            const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000;
            const result = await execMgr.execute(code, { timeoutMs });
            content = JSON.stringify({ durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr }, null, 2);
            break;
          }
          default:
            content = JSON.stringify({ error: `Unknown tool: ${name}` });
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content,
        });
      }
    }

    return {
      ok: false,
      latencyMs: Date.now() - start,
      roundTrips,
      promptTokens,
      completionTokens,
      finalMessage: null,
      error: `Max rounds (${MAX_ROUNDS}) exceeded`,
      messageCount: messages.length,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      roundTrips,
      promptTokens,
      completionTokens,
      finalMessage: null,
      error: err instanceof Error ? err.message : String(err),
      messageCount: messages.length,
    };
  }
}
