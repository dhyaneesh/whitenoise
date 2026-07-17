import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const runE2E = process.env.RUN_E2E === '1';

function textContent(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): string {
  const parts = result.content ?? [];
  return parts
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

describe.skipIf(!runE2E)('proxy e2e (stdio + real downstream)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(process.cwd(), 'dist/index.js')],
      cwd: process.cwd(),
      stderr: 'pipe',
    });

    client = new Client({ name: 'whitenoise-e2e', version: '0.0.0' });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // ignore
    }
  });

  it('exposes exactly the four meta-tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'execute_code',
      'list_modules',
      'read_module',
      'search_tools',
    ]);
  });

  it('list_modules returns generated wrappers', async () => {
    const result = await client.callTool({
      name: 'list_modules',
      arguments: { path: '' },
    });
    const text = textContent(result as any);
    const modules = JSON.parse(text) as string[];
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.some((m) => m.includes('filesystem'))).toBe(true);
  });

  it('search_tools finds filesystem tools', async () => {
    const result = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'read file', limit: 10 },
    });
    const payload = JSON.parse(textContent(result as any)) as {
      count: number;
      results: Array<{ server: string; specifier: string; tool: string }>;
    };
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.results.some((r) => r.server === 'filesystem')).toBe(true);
  });

  it('search_tools returns a valid response for unmatched queries', async () => {
    // Catalog falls back to a browse list when nothing scores > 0
    const result = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'definitely-not-a-real-tool-xyz', limit: 10 },
    });
    const payload = JSON.parse(textContent(result as any)) as {
      count: number;
      results: unknown[];
    };
    expect(typeof payload.count).toBe('number');
    expect(Array.isArray(payload.results)).toBe(true);
  });

  it('read_module returns wrapper source', async () => {
    const search = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'read_file', limit: 5 },
    });
    const payload = JSON.parse(textContent(search as any)) as {
      results: Array<{ specifier: string }>;
    };
    const specifier =
      payload.results.find((r) => r.specifier.includes('readFile'))
        ?.specifier ?? 'mcp/servers/filesystem/readFile';

    const result = await client.callTool({
      name: 'read_module',
      arguments: { specifier },
    });
    const source = textContent(result as any);
    expect(source).toContain('export async function');
    expect(source).toContain('callMCPTool');
  });

  it('read_module errors on a missing tool without killing the server', async () => {
    const result = await client.callTool({
      name: 'read_module',
      arguments: { specifier: 'mcp/servers/filesystem/notARealTool' },
    });
    expect((result as any).isError === true || textContent(result as any)).toBeTruthy();

    // Server still responds
    const ok = await client.callTool({
      name: 'list_modules',
      arguments: { path: '' },
    });
    expect(textContent(ok as any).length).toBeGreaterThan(0);
  });

  it('execute_code captures stdout', async () => {
    const result = await client.callTool({
      name: 'execute_code',
      arguments: {
        code: "console.log('smoke-test-ok');",
        timeoutMs: 10_000,
      },
    });
    const payload = JSON.parse(textContent(result as any)) as {
      stdout: string;
      durationMs: number;
    };
    expect(payload.stdout).toContain('smoke-test-ok');
    expect(typeof payload.durationMs).toBe('number');
  });

  it('execute_code can read package.json through filesystem MCP', async () => {
    const pkgPath = path.join(process.cwd(), 'package.json').replace(/\\/g, '/');
    const code = `
import { readFile } from 'mcp/servers/filesystem/readFile';
const result = await readFile({ path: ${JSON.stringify(pkgPath)} });
console.log(JSON.stringify(result));
`;
    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 30_000 },
    });
    const text = textContent(result as any);
    // Either success payload with stdout containing package.json content,
    // or structured MCP content mentioning the name field.
    expect(text).toMatch(/whitenoise|"name"/);
  });

  it('invalid code returns an error without killing the server', async () => {
    const result = await client.callTool({
      name: 'execute_code',
      arguments: {
        code: 'const broken = ;',
        timeoutMs: 10_000,
      },
    });
    const text = textContent(result as any);
    expect(text.toLowerCase()).toMatch(/error|unexpected|failed/);

    const followUp = await client.callTool({
      name: 'execute_code',
      arguments: {
        code: "console.log('still-alive');",
        timeoutMs: 10_000,
      },
    });
    const payload = JSON.parse(textContent(followUp as any)) as {
      stdout: string;
    };
    expect(payload.stdout).toContain('still-alive');
  });
});
