import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createFakePool } from '../helpers/fakePool.js';
import { makeTempDir, removeTempDir } from '../helpers/tempDir.js';
import type { DownstreamPool } from '../../src/downstream/pool.js';

async function loadDist() {
  const catalogUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/downstream/catalog.js')
  ).href;
  const generateUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/wrappers/generate.js')
  ).href;
  const managerUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/wrappers/manager.js')
  ).href;
  const modulesUrl = pathToFileURL(
    path.join(process.cwd(), 'dist/wrappers/modules.js')
  ).href;

  const [{ ToolCatalog }, { generateWrappers }, manager, modules] =
    await Promise.all([
      import(catalogUrl),
      import(generateUrl),
      import(managerUrl),
      import(modulesUrl),
    ]);

  return {
    ToolCatalog,
    generateWrappers,
    prepareWrappers: manager.prepareWrappers as (
      catalog: InstanceType<typeof ToolCatalog>
    ) => Promise<void>,
    listModules: modules.listModules as (p?: string) => Promise<string[]>,
    readModule: modules.readModule as (specifier: string) => Promise<string>,
  };
}

describe('generateWrappers + modules', () => {
  let tempDir: string;
  let dist: Awaited<ReturnType<typeof loadDist>>;

  beforeAll(async () => {
    dist = await loadDist();
    tempDir = await makeTempDir('wn-gen-');
  });

  afterAll(async () => {
    await removeTempDir(tempDir);
  });

  it('writes bridge and per-tool wrappers with docs and describes', async () => {
    const pool = createFakePool();
    const catalog = new dist.ToolCatalog(pool as unknown as DownstreamPool);
    await catalog.refresh();

    await dist.generateWrappers(tempDir, catalog);

    const bridge = await readFile(
      path.join(tempDir, 'bridge', 'callMCPTool.ts'),
      'utf8'
    );
    expect(bridge).toContain('callMCPTool');

    const wrapper = await readFile(
      path.join(tempDir, 'servers', 'filesystem', 'readFile.ts'),
      'utf8'
    );
    expect(wrapper).toContain('export async function readFile');
    expect(wrapper).toContain("callMCPTool('filesystem__read_file'");
    expect(wrapper).toMatch(/Read the contents of a file/i);

    const schema = await readFile(
      path.join(tempDir, 'servers', 'filesystem', 'readFile.schema.ts'),
      'utf8'
    );
    expect(schema).toContain('ReadFileSchema');
    expect(schema).toContain(
      '.describe("Absolute path to the file to read")'
    );
  });

  it('prepareWrappers + listModules / readModule work end-to-end', async () => {
    const pool = createFakePool();
    const catalog = new dist.ToolCatalog(pool as unknown as DownstreamPool);
    await catalog.refresh();

    await dist.prepareWrappers(catalog);

    const modules = await dist.listModules('');
    expect(modules.some((m) => m === 'mcp/servers/filesystem/readFile')).toBe(
      true
    );
    expect(
      modules.some((m) => m === 'mcp/servers/filesystem/readFile.schema')
    ).toBe(true);
    expect(modules.some((m) => m.includes('memory'))).toBe(true);

    const source = await dist.readModule('mcp/servers/filesystem/readFile');
    expect(source).toContain('export async function readFile');

    await expect(dist.readModule('not-mcp/foo')).rejects.toThrow(
      /Invalid module specifier/
    );

    await expect(
      dist.readModule('mcp/servers/filesystem/notARealTool')
    ).rejects.toThrow();
  });
});
