import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVERS_JSON = path.join(__dirname, '../src/downstream/servers.json');
const TIMEOUT_MS = 120_000;

interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface HealthResult {
  name: string;
  status: 'ok' | 'fail' | 'timeout';
  tools?: number;
  error?: string;
  durationMs: number;
}

function loadServers(): ServerConfig[] {
  const raw = readFileSync(SERVERS_JSON, 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed.servers.map((s: any) => ({
    ...s,
    args: s.args.map((a: string) =>
      a === '$PROJECT_ROOT' ? path.resolve(__dirname, '..') : a
    ),
  }));
}

async function testServer(config: ServerConfig): Promise<HealthResult> {
  const start = Date.now();
  const client = new Client({ name: 'health-check', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
  });

  let tools: number | undefined;
  let error: string | undefined;

  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), TIMEOUT_MS)
      ),
    ]);

    const { tools: toolList } = await client.listTools();
    tools = toolList.length;
    await client.close();
    return { name: config.name, status: 'ok', tools, durationMs: Date.now() - start };
  } catch (err: any) {
    error = err.message || String(err);
    try { await client.close(); } catch {}
    return {
      name: config.name,
      status: error.includes('timeout') ? 'timeout' : 'fail',
      error,
      durationMs: Date.now() - start,
    };
  }
}

async function main() {
  const servers = loadServers();
  console.log(`\n🔬 MCP Health Check — testing ${servers.length} servers\n`);

  // Run sequentially to avoid npx thrashing
  const results: HealthResult[] = [];
  for (const server of servers) {
    process.stdout.write(`  Testing ${server.name}... `);
    const result = await testServer(server);
    results.push(result);
    if (result.status === 'ok') {
      console.log(`✅ OK (${result.tools} tools, ${result.durationMs}ms)`);
    } else {
      console.log(`❌ ${result.status.toUpperCase()} (${result.durationMs}ms)`);
      console.log(`     └─ ${result.error}`);
    }
  }

  // Summary
  const ok = results.filter((r) => r.status === 'ok');
  const failed = results.filter((r) => r.status !== 'ok');

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Total: ${results.length} | ✅ Pass: ${ok.length} | ❌ Fail: ${failed.length}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (failed.length > 0) {
    console.log('Failed servers:');
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
    console.log('');
  }

  // Overall score
  const score = Math.round((ok.length / results.length) * 100);
  if (score >= 80) {
    console.log(`🎉 Score: ${score}% — Infrastructure ready for experiments`);
  } else if (score >= 50) {
    console.log(`⚡ Score: ${score}% — Partially ready, some MCPs need attention`);
  } else {
    console.log(`❌ Score: ${score}% — Significant issues, fix before running experiments`);
  }
  console.log('');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
