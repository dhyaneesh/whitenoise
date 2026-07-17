import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { listModules, readModule } from '../../src/wrappers/modules.js';

describe('listModules + readModule (unit)', () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = path.join('/tmp', `wn-modules-unit-${Date.now()}`);
    await mkdir(baseDir, { recursive: true });
    const fsDir = path.join(baseDir, 'servers', 'filesystem');
    const memDir = path.join(baseDir, 'servers', 'memory');
    await mkdir(fsDir, { recursive: true });
    await mkdir(memDir, { recursive: true });
    await writeFile(
      path.join(fsDir, 'readFile.ts'),
      'export async function readFile() {}'
    );
    await writeFile(
      path.join(fsDir, 'readFile.schema.ts'),
      'export const ReadFileSchema = z.object({});'
    );
    await writeFile(
      path.join(memDir, 'createEntities.ts'),
      'export async function createEntities() {}'
    );
    // directory with .ts suffix to test readModule directory rejection
    await mkdir(path.join(baseDir, 'servers', 'fakeDir.ts'), {
      recursive: true,
    });
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('lists all modules recursively', async () => {
    const all = await listModules('', baseDir);
    expect(all).toContain('mcp/servers/filesystem/readFile');
    expect(all).toContain('mcp/servers/filesystem/readFile.schema');
    expect(all).toContain('mcp/servers/memory/createEntities');
  });

  it('narrows listing with a subPath', async () => {
    const fsOnly = await listModules('servers/filesystem', baseDir);
    expect(fsOnly).toContain('mcp/servers/filesystem/readFile');
    expect(fsOnly).toContain('mcp/servers/filesystem/readFile.schema');
    expect(
      fsOnly.every((m) => m.startsWith('mcp/servers/filesystem'))
    ).toBe(true);
  });

  it('readModule returns source for a tool wrapper', async () => {
    const src = await readModule('mcp/servers/filesystem/readFile', baseDir);
    expect(src).toContain('export async function readFile');
  });

  it('readModule returns source for a schema wrapper', async () => {
    const src = await readModule(
      'mcp/servers/filesystem/readFile.schema',
      baseDir
    );
    expect(src).toContain('ReadFileSchema');
  });

  it('readModule rejects invalid specifier prefix', async () => {
    await expect(readModule('not-mcp/foo', baseDir)).rejects.toThrow(
      /Invalid module specifier/
    );
  });

  it('readModule rejects a directory path masquerading as a file', async () => {
    await expect(
      readModule('mcp/servers/fakeDir', baseDir)
    ).rejects.toThrow(/Not a file/);
  });
});
