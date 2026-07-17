import { describe, it, expect } from 'vitest';
import { ToolCatalog } from '../../src/downstream/catalog.js';
import { createFakePool } from '../helpers/fakePool.js';
import type { DownstreamPool } from '../../src/downstream/pool.js';
import {
  classifyExecutionError,
  WorkerExecutionError,
} from '../../src/telemetry/errors.js';
import {
  byteLength,
  countMcpImports,
  jsonByteLength,
  lineCount,
  sha256Hex,
} from '../../src/telemetry/attributes.js';

function catalogFrom(pool: ReturnType<typeof createFakePool>) {
  return new ToolCatalog(pool as unknown as DownstreamPool);
}

describe('searchDetailed', () => {
  it('reports zeroMatch and fallbackUsed when nothing scores', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();

    const detailed = catalog.searchDetailed(
      'zzzzqqqxxxyyy-nomatch-999',
      5
    );
    expect(detailed.zeroMatch).toBe(true);
    expect(detailed.fallbackUsed).toBe(true);
    expect(detailed.topScore).toBe(0);
    expect(detailed.results.length).toBeGreaterThan(0);
    expect(detailed.results.length).toBeLessThanOrEqual(5);
  });

  it('reports topScore and no fallback on a real match', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();

    const detailed = catalog.searchDetailed('read', 10);
    expect(detailed.zeroMatch).toBe(false);
    expect(detailed.fallbackUsed).toBe(false);
    expect(detailed.topScore).toBeGreaterThan(0);
    expect(detailed.results[0]?.tool).toBe('read_file');
  });

  it('search() remains a thin wrapper over searchDetailed().results', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();
    const viaSearch = catalog.search('memory', 10);
    const viaDetailed = catalog.searchDetailed('memory', 10).results;
    expect(viaSearch.map((e) => e.fqTool)).toEqual(
      viaDetailed.map((e) => e.fqTool)
    );
  });

  it('exposes catalog definition_bytes after refresh', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();
    expect(catalog.getDefinitionBytes()).toBeGreaterThan(0);
    expect(catalog.listAll().length).toBeGreaterThan(0);
  });
});

describe('classifyExecutionError', () => {
  it('maps typed errors without relying on message text', () => {
    const queue = new Error('Execution queue is full');
    queue.name = 'QueueFullError';
    expect(classifyExecutionError(queue).type).toBe('QUEUE_FULL');

    const timeout = new Error('Execution timed out: x');
    timeout.name = 'ExecutionTimeoutError';
    expect(classifyExecutionError(timeout).type).toBe('EXECUTION_TIMEOUT');

    const crash = new Error('boom');
    crash.name = 'WorkerCrashedError';
    expect(classifyExecutionError(crash).type).toBe('WORKER_CRASH');

    const down = new Error('Downstream server not connected: fs');
    down.name = 'DownstreamUnavailableError';
    expect(classifyExecutionError(down).type).toBe('DOWNSTREAM_UNAVAILABLE');
  });

  it('uses worker-provided error categories', () => {
    const err = new WorkerExecutionError(
      'COMPILATION_ERROR',
      'Expected expression'
    );
    const classified = classifyExecutionError(err);
    expect(classified.type).toBe('COMPILATION_ERROR');
    expect(classified.recoverable).toBe(true);
    expect(classified.message).not.toMatch(/stack/i);
  });
});

describe('code metadata helpers', () => {
  it('hashes and counts without exposing raw code', () => {
    const code = `import { readFile } from 'mcp/servers/filesystem/readFile';\nconsole.log(1);\n`;
    expect(sha256Hex(code)).toHaveLength(64);
    expect(byteLength(code)).toBeGreaterThan(0);
    expect(lineCount(code)).toBe(3);
    const imports = countMcpImports(code);
    expect(imports.importCount).toBe(1);
    expect(imports.toolCount).toBe(1);
    expect(imports.uniqueServers).toBe(1);
  });

  it('lineCount handles empty string and trailing newline', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a\n')).toBe(2);
    expect(lineCount('a\r\n')).toBe(2);
  });

  it('countMcpImports counts bridge imports separately from server imports', () => {
    const code = `import { callMCPTool } from 'mcp/bridge/callMCPTool';\nimport { readFile } from 'mcp/servers/filesystem/readFile';`;
    const imports = countMcpImports(code);
    expect(imports.importCount).toBe(2);
    expect(imports.toolCount).toBe(1);
    expect(imports.uniqueServers).toBe(1);
  });

  it('countMcpImports deduplicates unique servers across multiple tools', () => {
    const code = `import { readFile } from 'mcp/servers/filesystem/readFile';\nimport { writeFile } from 'mcp/servers/filesystem/writeFile';\nimport { createEntities } from 'mcp/servers/memory/createEntities';`;
    const imports = countMcpImports(code);
    expect(imports.importCount).toBe(3);
    expect(imports.toolCount).toBe(3);
    expect(imports.uniqueServers).toBe(2);
  });
});

describe('jsonByteLength', () => {
  it('measures JSON byte length of plain objects', () => {
    expect(jsonByteLength({ a: 1 })).toBeGreaterThan(0);
  });

  it('returns 0 for circular structures', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    expect(jsonByteLength(obj)).toBe(0);
  });
});
