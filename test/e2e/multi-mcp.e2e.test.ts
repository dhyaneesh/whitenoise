import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const runE2E = process.env.RUN_E2E === '1';

const isolatedTmpDir = path.join(os.tmpdir(), `meta-mcp-proxy-multi-${process.pid}`);

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

/** Helper to unwrap MCPResult envelope inside execute_code workers */
function unwrapCode(helperName: string = 'unwrap'): string {
  return `
function ${helperName}(result: any): any {
  if (result && result.isError) throw new Error(result.content?.[0]?.text || 'MCP error');
  if (result && result.structuredContent !== undefined) return result.structuredContent;
  if (result && result.content?.[0]?.text) {
    const text = result.content[0].text;
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch {
      return text;
    }
  }
  return result;
}
`;
}

describe.skipIf(!runE2E)('multi-mcp orchestration e2e', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(process.cwd(), 'dist/index.js')],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: {
        ...process.env,
        WN_BASE_TMP: isolatedTmpDir,
        BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
      },
    });
    client = new Client({ name: 'whitenoise-multi-mcp-e2e', version: '0.0.0' });
    await client.connect(transport, { timeout: 180_000 });
  }, 180_000);

  afterAll(async () => {
    try { await client?.close(); } catch {}
    try {
      await fs.promises.rm(isolatedTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ── Tier E1: Web Research & Knowledge Graph ──────────────────

  it('E1: search web, store in memory graph, write report (3 MCPs)', async () => {
    const search = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'web search', limit: 10 },
    });
    const searchPayload = JSON.parse(textContent(search as any)) as {
      results: Array<{ server: string; specifier: string }>;
    };
    expect(searchPayload.results.some((r) => r.server === 'braveSearch')).toBe(true);

    const searchMod = searchPayload.results.find((r) => r.server === 'braveSearch');
    expect(searchMod).toBeDefined();
    const read = await client.callTool({
      name: 'read_module',
      arguments: { specifier: searchMod!.specifier },
    });
    const source = textContent(read as any);
    expect(source).toContain('export');

    const code = `
${unwrapCode()}
import { braveWebSearch } from 'mcp/servers/braveSearch/braveWebSearch';
import { createEntities } from 'mcp/servers/memory/createEntities';
import { readGraph } from 'mcp/servers/memory/readGraph';
import { writeFile } from 'mcp/servers/filesystem/writeFile';

const rawResults = unwrap(await braveWebSearch({ query: 'MCP server security best practices 2024', count: 3 }));
const results = Array.isArray(rawResults) ? rawResults : (rawResults.results || []);

for (const [i, r] of results.entries()) {
  await createEntities({
    entities: [{
      name: \`article_\${i}\`,
      entityType: 'web_article',
      observations: [\`Title: \${r.title || 'untitled'}\`, \`URL: \${r.url || ''}\`]
    }]
  });
}

const graph = unwrap(await readGraph({}));

const report = JSON.stringify({ searchResults: results.length, graphNodes: graph.entities.length, sample: results[0] }, null, 2);
await writeFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/tmp/e1-report.md', content: report });

console.log('E1_OK');
`;

    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 60_000 },
    });
    const text = textContent(result as any);
    expect(text).toContain('E1_OK');

    const fsRead = await client.callTool({
      name: 'execute_code',
      arguments: {
        code: `
import { readFile } from 'mcp/servers/filesystem/readFile';
const content = await readFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/tmp/e1-report.md' });
console.log(content);
`,
        timeoutMs: 10_000,
      },
    });
    const reportText = textContent(fsRead as any);
    expect(reportText).toContain('graphNodes');
  }, 120_000);

  // ── Tier E2: Project Health Check ─────────────────────────────

  it('E2: github + filesystem + sequentialThinking (3 MCPs)', async () => {
    const code = `
${unwrapCode()}
import { searchRepositories } from 'mcp/servers/github/searchRepositories';
import { directoryTree } from 'mcp/servers/filesystem/directoryTree';
import { readFile } from 'mcp/servers/filesystem/readFile';
import { sequentialthinking } from 'mcp/servers/sequentialThinking/sequentialthinking';
import { writeFile } from 'mcp/servers/filesystem/writeFile';

const repoPath = '/mnt/c/Users/Dhyaneesh/whitenoise';

let githubResult = 'not_found';
try {
  const repos = unwrap(await searchRepositories({ query: 'whitenoise MCP proxy', sort: 'stars', order: 'desc' }));
  githubResult = repos.length > 0 ? \`found_\${repos.length}_repos\` : 'no_results';
} catch (e) {
  githubResult = 'api_error';
}

const tree = unwrap(await directoryTree({ path: repoPath + '/src' }));

const pkgRawResult = unwrap(await readFile({ path: repoPath + '/package.json' }));
const pkg = JSON.parse(pkgRawResult.content || pkgRawResult);

const reasoning = unwrap(await sequentialthinking({ thought: \`Project has package \${pkg.name}, GitHub search: \${githubResult}. Tree has entries. Is this well maintained?\`, nextThoughtNeeded: true, thoughtNumber: 1, totalThoughts: 3 }));

const report = JSON.stringify({ githubStatus: githubResult, pkgName: pkg.name, reasoning: reasoning.thought }, null, 2);
await writeFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/tmp/e2-health.json', content: report });

console.log('E2_OK');
`;

    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 60_000 },
    });
    const text = textContent(result as any);
    expect(text).toContain('E2_OK');
  }, 90_000);

  // ── Tier E3: Web Research to Knowledge Graph ──────────────────

  it('E3: braveSearch + memory + filesystem (3 MCPs)', async () => {
    const code = `
${unwrapCode()}
import { braveWebSearch } from 'mcp/servers/braveSearch/braveWebSearch';
import { createEntities } from 'mcp/servers/memory/createEntities';
import { createRelations } from 'mcp/servers/memory/createRelations';
import { searchNodes } from 'mcp/servers/memory/searchNodes';
import { writeFile } from 'mcp/servers/filesystem/writeFile';

const rawResults = unwrap(await braveWebSearch({ query: 'AI agent frameworks 2024', count: 5 }));
const results = Array.isArray(rawResults) ? rawResults : (rawResults.results || []);

const entities = results.map((r: any, i: number) => ({
  name: \`result_\${i}\`,
  entityType: 'search_result',
  observations: [\`Title: \${r.title || 'untitled'}\`, \`URL: \${r.url || ''}\`]
}));
await createEntities({ entities });

for (let i = 0; i < entities.length - 1; i++) {
  await createRelations({
    relations: [{
      from: entities[i].name,
      to: entities[i + 1].name,
      relationType: 'related_to'
    }]
  });
}

const found = unwrap(await searchNodes({ query: 'AI' }));

const report = JSON.stringify({ results: results.length, graphEntities: entities.length, matchedNodes: found.entities.length }, null, 2);
await writeFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/tmp/e3-knowledge.json', content: report });

console.log('E3_OK');
`;

    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 60_000 },
    });
    const text = textContent(result as any);
    expect(text).toContain('E3_OK');
  }, 120_000);

  // ── Tier M1: Competitive Intelligence ─────────────────────────

  it('M1: braveSearch + github + filesystem + memory + sequentialThinking + everything (6 MCPs)', async () => {
    const code = `
${unwrapCode()}
import { braveWebSearch } from 'mcp/servers/braveSearch/braveWebSearch';
import { searchRepositories } from 'mcp/servers/github/searchRepositories';
import { readFile } from 'mcp/servers/filesystem/readFile';
import { directoryTree } from 'mcp/servers/filesystem/directoryTree';
import { createEntities } from 'mcp/servers/memory/createEntities';
import { readGraph } from 'mcp/servers/memory/readGraph';
import { sequentialthinking } from 'mcp/servers/sequentialThinking/sequentialthinking';
import { writeFile } from 'mcp/servers/filesystem/writeFile';

const [webResultsRaw, githubReposRaw, treeRaw] = await Promise.all([
  braveWebSearch({ query: 'MCP proxy meta-tool competitor whitenoise alternative 2024', count: 3 }).catch(() => ({ content: [{ type: 'text', text: '{"results":[]}' }] })),
  searchRepositories({ query: 'MCP proxy', sort: 'stars', order: 'desc' }).catch(() => ({ content: [{ type: 'text', text: '[]' }] })),
  directoryTree({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/src' }),
]);

const webResultsRawParsed = (() => { try { return unwrap(webResultsRaw); } catch { return { results: [] }; } })();
const webResults = Array.isArray(webResultsRawParsed) ? webResultsRawParsed : (webResultsRawParsed.results || []);
const githubRepos = (() => { try { return unwrap(githubReposRaw); } catch { return []; } })();

const reasoning = unwrap(await sequentialthinking({
  thought: \`Found \${webResults.length} web competitors, \${githubRepos.length} GitHub repos. Analyze gaps.\`,
  nextThoughtNeeded: true,
  thoughtNumber: 1,
  totalThoughts: 3
}));

const entities = [
  { name: 'whitenoise_local', entityType: 'project', observations: [\`Tree entries present\`] },
  ...webResults.map((r: any, i: number) => ({
    name: \`competitor_\${i}\`,
    entityType: 'competitor',
    observations: [r.title || 'unknown', r.url || '']
  })),
  ...githubRepos.slice(0, 2).map((r: any, i: number) => ({
    name: \`github_repo_\${i}\`,
    entityType: 'github_project',
    observations: [\`\${r.full_name}: \${r.stargazers_count} stars\`]
  })),
];
await createEntities({ entities });
const graph = unwrap(await readGraph({}));

const report = JSON.stringify({
  competitorsFound: webResults.length,
  githubRepos: githubRepos.length,
  graphEntities: graph.entities.length,
  reasoning: reasoning.thought,
}, null, 2);
await writeFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/tmp/m1-competitors.json', content: report });

console.log('M1_OK');
`;

    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 90_000 },
    });
    const text = textContent(result as any);
    expect(text).toContain('M1_OK');
  }, 150_000);

  // ── Tier M3: Data Migration Pipeline ──────────────────────────

  it('M3: memory + postgres + sequentialThinking + filesystem + github (5 MCPs)', async () => {
    const code = `
${unwrapCode()}
import { createEntities } from 'mcp/servers/memory/createEntities';
import { readGraph } from 'mcp/servers/memory/readGraph';
import { query as pgQuery } from 'mcp/servers/postgres/query';
import { sequentialthinking } from 'mcp/servers/sequentialThinking/sequentialthinking';
import { writeFile } from 'mcp/servers/filesystem/writeFile';
import { searchRepositories } from 'mcp/servers/github/searchRepositories';

for (let i = 1; i <= 10; i++) {
  await createEntities({
    entities: [{
      name: \`sensor_\${i}\`,
      entityType: 'sensor_reading',
      observations: [\`temp: \${20 + Math.random()*10}\`, \`humidity: \${40 + Math.random()*20}\`]
    }]
  });
}
const graph = unwrap(await readGraph({}));

const plan = unwrap(await sequentialthinking({
  thought: \`Memory graph has \${graph.entities.length} sensor readings. Plan migration to Postgres.\`,
  nextThoughtNeeded: true,
  thoughtNumber: 1,
  totalThoughts: 3
}));

await pgQuery({ sql: 'CREATE TABLE IF NOT EXISTS readings (id SERIAL PRIMARY KEY, name TEXT, temperature REAL, humidity REAL);' });

for (const entity of graph.entities.filter((e: any) => e.entityType === 'sensor_reading')) {
  const temp = parseFloat(entity.observations[0].replace('temp: ', ''));
  const humidity = parseFloat(entity.observations[1].replace('humidity: ', ''));
  await pgQuery({
    sql: \`INSERT INTO readings (name, temperature, humidity) VALUES ('\${entity.name}', \${temp}, \${humidity});\`
  });
}

const pgCount = unwrap(await pgQuery({ sql: 'SELECT COUNT(*) as c FROM readings;' }));

let githubResult = 'skipped';
try {
  const repos = unwrap(await searchRepositories({ query: 'iot sensor dashboard', sort: 'stars' }));
  githubResult = \`found_\${repos.length}_repos\`;
} catch (e) {
  githubResult = 'api_limit';
}

const log = JSON.stringify({
  graphEntities: graph.entities.length,
  pgRows: pgCount[0].c,
  plan: plan.thought,
  githubBonus: githubResult,
}, null, 2);
await writeFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/tmp/m3-migration.json', content: log });

console.log('M3_OK');
`;

    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 60_000 },
    });
    const text = textContent(result as any);
    expect(text).toContain('M3_OK');
  }, 120_000);

  // ── Tier H1: Autonomous Research Agent ────────────────────────

  it('H1: research agent with web + github + filesystem + memory + postgres + sequentialThinking (6 MCPs)', async () => {
    const code = `
${unwrapCode()}
import { braveWebSearch } from 'mcp/servers/braveSearch/braveWebSearch';
import { searchRepositories } from 'mcp/servers/github/searchRepositories';
import { readFile } from 'mcp/servers/filesystem/readFile';
import { directoryTree } from 'mcp/servers/filesystem/directoryTree';
import { createEntities } from 'mcp/servers/memory/createEntities';
import { readGraph } from 'mcp/servers/memory/readGraph';
import { query as pgQuery } from 'mcp/servers/postgres/query';
import { sequentialthinking } from 'mcp/servers/sequentialThinking/sequentialthinking';
import { writeFile } from 'mcp/servers/filesystem/writeFile';

const [webResultsRaw, treeRaw, pkgRawRaw] = await Promise.all([
  braveWebSearch({ query: 'AI agent framework 2024 2025', count: 3 }).catch(() => ({ content: [{ type: 'text', text: '{"results":[]}' }] })),
  directoryTree({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/src' }),
  readFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/package.json' }).catch(() => ({ content: [{ type: 'text', text: '{}' }] })),
]);

const webResultsRawParsed = (() => { try { return unwrap(webResultsRaw); } catch { return { results: [] }; } })();
const webResults = Array.isArray(webResultsRawParsed) ? webResultsRawParsed : (webResultsRawParsed.results || []);
const pkgRawResult = (() => { try { return unwrap(pkgRawRaw); } catch { return { content: '{}' }; } })();
const pkgRaw = pkgRawResult.content || pkgRawResult;

let githubRepos: any[] = [];
try {
  githubRepos = unwrap(await searchRepositories({ query: 'AI agent framework typescript', sort: 'stars', order: 'desc' }));
} catch (e) {
  githubRepos = [];
}

const analysis = unwrap(await sequentialthinking({
  thought: \`Web: \${webResults.length} frameworks. GitHub: \${githubRepos.length} repos. Package: \${JSON.parse(pkgRaw).name || "unknown"}. Research landscape.\`,
  nextThoughtNeeded: true,
  thoughtNumber: 1,
  totalThoughts: 3
}));

const entities = [
  ...webResults.map((r: any, i: number) => ({
    name: \`framework_web_\${i}\`,
    entityType: 'ai_framework',
    observations: [r.title || 'unknown', r.url || '']
  })),
  ...githubRepos.slice(0, 2).map((r: any, i: number) => ({
    name: \`framework_gh_\${i}\`,
    entityType: 'ai_framework_github',
    observations: [\`\${r.full_name}: \${r.stargazers_count} stars, \${r.language || 'unknown'}\`]
  })),
];
await createEntities({ entities });
const graph = unwrap(await readGraph({}));

await pgQuery({ sql: 'CREATE TABLE IF NOT EXISTS research_archive (id SERIAL PRIMARY KEY, source TEXT, count INT, framework TEXT);' });
await pgQuery({ sql: \`INSERT INTO research_archive (source, count, framework) VALUES ('web', \${webResults.length}, 'mixed');\` });
await pgQuery({ sql: \`INSERT INTO research_archive (source, count, framework) VALUES ('github', \${githubRepos.length}, 'typescript');\` });
const pgRows = unwrap(await pgQuery({ sql: 'SELECT COUNT(*) as c FROM research_archive;' }));

const report = JSON.stringify({
  webResults: webResults.length,
  githubRepos: githubRepos.length,
  reasoning: analysis.thought,
  graphEntities: graph.entities.length,
  pgRows: pgRows[0].c,
}, null, 2);
await writeFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/tmp/h1-research.json', content: report });

console.log('H1_OK');
`;

    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 90_000 },
    });
    const text = textContent(result as any);
    expect(text).toContain('H1_OK');
  }, 150_000);

  // ── Stress test: Error resilience ─────────────────────────────

  it('handles a failed MCP gracefully and continues with others', async () => {
    const code = `
${unwrapCode()}
import { readFile } from 'mcp/servers/filesystem/readFile';
import { createEntities } from 'mcp/servers/memory/createEntities';
import { readGraph } from 'mcp/servers/memory/readGraph';

let context7Result = 'skipped';
try {
  const { queryDocs } = await import('mcp/servers/context7/queryDocs');
  context7Result = unwrap(await queryDocs({ query: 'test', languages: ['typescript'] }));
} catch (e) {
  context7Result = 'failed_as_expected: ' + (e as Error).message;
}

const content = unwrap(await readFile({ path: '/mnt/c/Users/Dhyaneesh/whitenoise/package.json' }));
await createEntities({
  entities: [{
    name: 'resilience_test',
    entityType: 'test_result',
    observations: ['package_read_ok', 'context7_' + context7Result]
  }]
});
const graph = unwrap(await readGraph({}));

console.log('RESILIENCE_OK context7=' + context7Result + ' nodes=' + graph.entities.length);
`;

    const result = await client.callTool({
      name: 'execute_code',
      arguments: { code, timeoutMs: 30_000 },
    });
    const text = textContent(result as any);
    expect(text).toContain('RESILIENCE_OK');
    expect(text).toContain('failed_as_expected');
  }, 60_000);
});
