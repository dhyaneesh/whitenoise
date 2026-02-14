import { GoogleGenAI } from '@google/genai';
import type { Content, Part, FunctionDeclaration } from '@google/genai';
import { getVanillaTools, getWhiteNoiseTools } from './llmTools.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
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

/* ------------------------------------------------------------------ */
/*  Vanilla MCP – all downstream tools exposed directly to Gemini     */
/* ------------------------------------------------------------------ */

export async function runVanilla(
  task: string,
  pool: PoolLike,
  catalog: CatalogLike,
  apiKey: string,
  model: string = DEFAULT_MODEL,
): Promise<LLMRunResult> {
  const ai = new GoogleGenAI({ apiKey });
  const toolDeclarations: FunctionDeclaration[] = getVanillaTools(catalog.listAll());
  const start = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let roundTrips = 0;

  const systemInstruction =
    'You have access to MCP tools. Use them to complete the user\'s task. Tool names are fully-qualified (e.g. everything__echo, memory__create_entity). Call tools when needed, then summarize the result for the user.';

  const contents: Content[] = [
    { role: 'user', parts: [{ text: task }] },
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          tools: toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations }] : undefined,
        },
      });

      // Track token usage
      if (response.usageMetadata) {
        promptTokens += response.usageMetadata.promptTokenCount ?? 0;
        completionTokens += response.usageMetadata.candidatesTokenCount ?? 0;
      }
      roundTrips++;

      const candidate = response.candidates?.[0];
      if (!candidate?.content) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          roundTrips,
          promptTokens,
          completionTokens,
          finalMessage: null,
          error: 'No content in response',
          messageCount: contents.length,
        };
      }

      // Append the model's response to the conversation
      contents.push(candidate.content);

      // Check for function calls
      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        // No function calls – this is the final text response
        return {
          ok: true,
          latencyMs: Date.now() - start,
          roundTrips,
          promptTokens,
          completionTokens,
          finalMessage: response.text ?? null,
          messageCount: contents.length,
        };
      }

      // Execute each function call and collect responses
      const functionResponseParts: Part[] = [];
      for (const fc of functionCalls) {
        const name = fc.name!;
        const args = (fc.args ?? {}) as Record<string, unknown>;
        const { server, tool } = parseFqTool(name);
        const client = pool.getClient(server);
        const result = await client.callTool({ name: tool, arguments: args });
        functionResponseParts.push({
          functionResponse: {
            name,
            response: { result: mcpResultToContent(result) },
          },
        });
      }

      // Append function responses as a user turn
      contents.push({ role: 'user', parts: functionResponseParts });
    }

    return {
      ok: false,
      latencyMs: Date.now() - start,
      roundTrips,
      promptTokens,
      completionTokens,
      finalMessage: null,
      error: `Max rounds (${MAX_ROUNDS}) exceeded`,
      messageCount: contents.length,
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
      messageCount: contents.length,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  WhiteNoise – 4 meta-tools exposed to Gemini                       */
/* ------------------------------------------------------------------ */

export async function runWhiteNoise(
  task: string,
  pool: PoolLike,
  catalog: CatalogLike,
  execMgr: ExecMgrLike,
  modules: ModulesLike,
  apiKey: string,
  model: string = DEFAULT_MODEL,
): Promise<LLMRunResult> {
  const ai = new GoogleGenAI({ apiKey });
  const toolDeclarations = getWhiteNoiseTools();
  const start = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let roundTrips = 0;

  const systemInstruction = `You have 4 meta-tools:
1. search_tools(query, limit?) — Search for downstream tools. Each result includes a specifier. Use that specifier in read_module to get the full wrapper source.
2. read_module(specifier) — Return the source of a wrapper. Use the specifier from search_tools results.
3. execute_code(code, timeoutMs?) — Run TypeScript that imports wrappers (from the specifiers you got) and calls the tools. Use read_module output to see exact imports and usage.
4. list_modules(path?) — Fallback: list all wrapper specifiers when search_tools does not give you what you need.

Flow: search_tools → read_module(specifier from results) → execute_code. Use list_modules only when search is insufficient. Complete the user's task.`;

  const contents: Content[] = [
    { role: 'user', parts: [{ text: task }] },
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: toolDeclarations }],
        },
      });

      // Track token usage
      if (response.usageMetadata) {
        promptTokens += response.usageMetadata.promptTokenCount ?? 0;
        completionTokens += response.usageMetadata.candidatesTokenCount ?? 0;
      }
      roundTrips++;

      const candidate = response.candidates?.[0];
      if (!candidate?.content) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          roundTrips,
          promptTokens,
          completionTokens,
          finalMessage: null,
          error: 'No content in response',
          messageCount: contents.length,
        };
      }

      // Append the model's response to the conversation
      contents.push(candidate.content);

      // Check for function calls
      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        return {
          ok: true,
          latencyMs: Date.now() - start,
          roundTrips,
          promptTokens,
          completionTokens,
          finalMessage: response.text ?? null,
          messageCount: contents.length,
        };
      }

      // Execute each meta-tool and collect responses
      const functionResponseParts: Part[] = [];
      for (const fc of functionCalls) {
        const name = fc.name!;
        const args = (fc.args ?? {}) as Record<string, unknown>;

        let resultPayload: unknown;
        switch (name) {
          case 'search_tools': {
            const query = typeof args.query === 'string' ? args.query : '';
            const limit = typeof args.limit === 'number' ? args.limit : 20;
            const results = catalog.search(query, limit);
            resultPayload = { query, count: results.length, results };
            break;
          }
          case 'list_modules': {
            const path = typeof args.path === 'string' ? args.path : '';
            const list = await modules.listModules(path);
            resultPayload = list;
            break;
          }
          case 'read_module': {
            const specifier = typeof args.specifier === 'string' ? args.specifier : '';
            const source = await modules.readModule(specifier);
            resultPayload = { source };
            break;
          }
          case 'execute_code': {
            const code = typeof args.code === 'string' ? args.code : '';
            const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000;
            const result = await execMgr.execute(code, { timeoutMs });
            resultPayload = { durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr };
            break;
          }
          default:
            resultPayload = { error: `Unknown tool: ${name}` };
        }

        functionResponseParts.push({
          functionResponse: {
            name,
            response: resultPayload as Record<string, unknown>,
          },
        });
      }

      // Append function responses as a user turn
      contents.push({ role: 'user', parts: functionResponseParts });
    }

    return {
      ok: false,
      latencyMs: Date.now() - start,
      roundTrips,
      promptTokens,
      completionTokens,
      finalMessage: null,
      error: `Max rounds (${MAX_ROUNDS}) exceeded`,
      messageCount: contents.length,
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
      messageCount: contents.length,
    };
  }
}
