import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { GenerationStore } from '../../src/wrappers/generations.js';
import { makeTempDir, removeTempDir } from '../helpers/tempDir.js';

describe('GenerationStore', () => {
  let base: string;
  let store: GenerationStore;

  beforeAll(async () => {
    base = await makeTempDir('wn-gen-store-');
    store = new GenerationStore(path.join(base, 'wrappers'));
    await store.init();
  });

  afterAll(async () => {
    await removeTempDir(base);
  });

  it('returns null from current() before any publish', () => {
    expect(store.current()).toBeNull();
    expect(store.acquireCurrent()).toBeNull();
  });

  it('publishes gen-1 and makes it current', async () => {
    const result = await store.publish(async (genDir) => {
      await mkdir(genDir, { recursive: true });
      await writeFile(path.join(genDir, 'test.txt'), 'gen-1-content');
    });
    expect(result.id).toBe(1);
    expect(store.current()?.id).toBe(1);
    expect(store.current()?.dir).toBe(result.dir);
  });

  it('acquireCurrent pins the generation', () => {
    const gen = store.acquireCurrent();
    expect(gen?.id).toBe(1);
    // second acquire also works
    const gen2 = store.acquireCurrent();
    expect(gen2?.id).toBe(1);
    store.release(1);
    store.release(1);
  });

  it('publishes gen-2 atomically and flips current', async () => {
    const result = await store.publish(async (genDir) => {
      await mkdir(genDir, { recursive: true });
      await writeFile(path.join(genDir, 'test.txt'), 'gen-2-content');
    });
    expect(result.id).toBe(2);
    expect(store.current()?.id).toBe(2);

    // gen-2 file is readable
    const text = await readFile(
      path.join(result.dir, 'test.txt'),
      'utf8'
    );
    expect(text).toBe('gen-2-content');
  });

  it('gc removes gen-1 (not current, no refcount) but keeps gen-2', async () => {
    const removed = await store.gc();
    expect(removed).toContain(1);
    expect(removed).not.toContain(2);

    // gen-1 dir is gone
    await expect(access(path.join(base, 'wrappers', 'gen-1'))).rejects.toThrow();
    // gen-2 dir still exists
    await expect(access(path.join(base, 'wrappers', 'gen-2'))).resolves.toBeUndefined();
  });

  it('gc keeps a pinned non-current generation', async () => {
    // Publish gen-3
    await store.publish(async (genDir) => {
      await mkdir(genDir, { recursive: true });
    });
    expect(store.current()?.id).toBe(3);

    // Pin gen-2 (not current)
    const gen2 = store.acquireCurrent();
    // Wait — gen-2 is not current anymore. We need to acquire gen-2 specifically.
    // acquireCurrent always pins the CURRENT gen. So to test pinning a non-current
    // gen, we simulate: acquire gen-3 (current), then publish gen-4, then gc.
    store.release(gen2!.id);

    // Acquire current (gen-3)
    const pinned = store.acquireCurrent();
    expect(pinned?.id).toBe(3);

    // Publish gen-4 while gen-3 is pinned
    await store.publish(async (genDir) => {
      await mkdir(genDir, { recursive: true });
    });
    expect(store.current()?.id).toBe(4);

    // GC should keep gen-3 (pinned) and gen-4 (current), remove gen-2
    const removed = await store.gc();
    expect(removed).toContain(2);
    expect(removed).not.toContain(3);
    expect(removed).not.toContain(4);

    // Release gen-3, then GC should remove it
    store.release(3);
    const removed2 = await store.gc();
    expect(removed2).toContain(3);
  });

  it('does not flip current if writeFn throws', async () => {
    const before = store.current()?.id;
    await expect(
      store.publish(async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');

    // Current pointer unchanged
    expect(store.current()?.id).toBe(before);
  });
});
