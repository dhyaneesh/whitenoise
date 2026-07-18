import { describe, it, expect } from 'vitest';
import { ToolCatalog } from '../../src/downstream/catalog.js';
import { createFakePool } from '../helpers/fakePool.js';
import type { DownstreamPool } from '../../src/downstream/pool.js';

function catalogFrom(pool: ReturnType<typeof createFakePool>) {
  return new ToolCatalog(pool as unknown as DownstreamPool);
}

describe('ToolCatalog', () => {
  it('refresh builds entries from all servers', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();

    const all = catalog.listAll();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.some((e) => e.fqTool === 'filesystem__read_file')).toBe(true);
    expect(all.some((e) => e.specifier === 'mcp/servers/filesystem/readFile')).toBe(
      true
    );
    expect(all.some((e) => e.server === 'memory')).toBe(true);
  });

  it('ranks tool-name matches above description matches', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();

    const results = catalog.search('read', 10);
    expect(results.length).toBeGreaterThan(0);
    // read_file tool name should beat a description-only hit
    expect(results[0].tool).toBe('read_file');
  });

  it('empty query returns deterministic browse order', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();

    const a = catalog.search('', 20);
    const b = catalog.search('   ', 20);
    expect(a.map((e) => e.fqTool)).toEqual(b.map((e) => e.fqTool));

    const tools = a.map((e) => e.tool);
    const sorted = [...tools].sort((x, y) => x.localeCompare(y));
    expect(tools).toEqual(sorted);
  });

  it('no-match query falls back to browse list', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();

    const results = catalog.search('definitely-not-a-real-tool-xyz', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('skips a failing server and still catalogs others', async () => {
    const catalog = catalogFrom(
      createFakePool({
        failingServers: ['memory'],
      })
    );
    await catalog.refresh();

    const all = catalog.listAll();
    expect(all.every((e) => e.server !== 'memory')).toBe(true);
    expect(all.some((e) => e.server === 'filesystem')).toBe(true);
    expect(catalog.getDegradedServers()).toContain('memory');
  });

  it('retains last-known-good entries when a server fails on a subsequent refresh', async () => {
    let memoryFails = false;
    const pool = createFakePool({
      toolsByServer: {
        filesystem: [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: { type: 'object' },
          },
        ],
        memory: [
          {
            name: 'create_entities',
            description: 'Create entities',
            inputSchema: { type: 'object' },
          },
        ],
      },
    });

    // Override listTools to toggle failures
    const origListTools = pool.listTools.bind(pool);
    pool.listTools = async (server: string) => {
      if (server === 'memory' && memoryFails) {
        throw new Error('listTools failed for memory');
      }
      return origListTools(server);
    };

    const catalog = catalogFrom(pool);
    await catalog.refresh();

    // memory present on first refresh
    expect(catalog.listAll().some((e) => e.server === 'memory')).toBe(true);
    expect(catalog.getDegradedServers()).not.toContain('memory');

    // Second refresh: memory fails — entries should be retained (degraded)
    memoryFails = true;
    await catalog.refresh();

    const all = catalog.listAll();
    const memoryEntries = all.filter((e) => e.server === 'memory');
    expect(memoryEntries.length).toBeGreaterThan(0);
    expect(memoryEntries.every((e) => e.degraded === true)).toBe(true);
    expect(catalog.getDegradedServers()).toContain('memory');

    // filesystem still fresh (not degraded)
    const fsEntries = all.filter((e) => e.server === 'filesystem');
    expect(fsEntries.every((e) => e.degraded !== true)).toBe(true);

    // Third refresh: memory recovers — degraded flag clears
    memoryFails = false;
    await catalog.refresh();
    expect(catalog.getDegradedServers()).not.toContain('memory');
    const memoryAfter = catalog.listAll().filter((e) => e.server === 'memory');
    expect(memoryAfter.every((e) => e.degraded !== true)).toBe(true);
  });

  it('includes inputSchemaRaw and description on entries', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();

    const read = catalog.listAll().find((e) => e.tool === 'read_file');
    expect(read?.description).toMatch(/Read the contents/i);
    expect(read?.inputSchemaRaw).toBeTruthy();
    expect(read?.inputSchema).toBeTruthy();
  });
});
