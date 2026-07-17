import { describe, it, expect } from 'vitest';
import { ToolCatalog } from '../../src/downstream/catalog.js';
import { createFakePool } from '../helpers/fakePool.js';
import type { DownstreamPool } from '../../src/downstream/pool.js';

function catalogFrom(pool: ReturnType<typeof createFakePool>) {
  return new ToolCatalog(pool as unknown as DownstreamPool);
}

describe('ToolCatalog extras', () => {
  it('getLastFailedServers reflects a failing server', async () => {
    const catalog = catalogFrom(
      createFakePool({ failingServers: ['memory'] })
    );
    await catalog.refresh();
    expect(catalog.getLastFailedServers()).toBe(1);
  });

  it('getDefinitionBytes returns a positive number after refresh', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();
    expect(catalog.getDefinitionBytes()).toBeGreaterThan(0);
  });

  it('multi-word search scores tool-name matches above description-only', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();
    const results = catalog.search('read file', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool).toBe('read_file');
  });

  it('search trims and lowercases the query', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();
    const a = catalog.search('READ_FILE', 5);
    const b = catalog.search('  read_file  ', 5);
    expect(a[0].tool).toBe('read_file');
    expect(b[0].tool).toBe('read_file');
  });

  it('search respects the limit parameter', async () => {
    const catalog = catalogFrom(createFakePool());
    await catalog.refresh();
    const all = catalog.search('', 100);
    const limited = catalog.search('', 1);
    expect(limited.length).toBe(1);
    expect(all.length).toBeGreaterThan(limited.length);
  });
});
