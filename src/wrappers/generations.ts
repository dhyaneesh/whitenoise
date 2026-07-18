// src/wrappers/generations.ts
import fs from 'node:fs';
import { mkdir, rm, symlink, rename, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLE_CACHE_ROOT } from '../paths.js';

export type GenerationId = number;

export type Generation = {
  id: GenerationId;
  /** Absolute path to the generation's wrapper directory. */
  dir: string;
};

export type PublishedGeneration = {
  id: GenerationId;
  dir: string;
};

/**
 * Manages atomic, immutable wrapper generations on disk.
 *
 * Layout under `rootDir`:
 *   gen-<id>/          — one complete, immutable generation
 *   current            — symlink (or pointer file) → gen-<id>
 *
 * Readers pin a generation via `acquireCurrent()` (refcount++) and `release()`.
 * A generation is only garbage-collected when its refcount drops to zero AND
 * it is no longer the current generation — so in-flight executions always see
 * a complete, stable set of wrapper files even while a new generation is
 * being published.
 */
export class GenerationStore {
  private readonly rootDir: string;
  private readonly currentPath: string;
  private counter: GenerationId = 0;
  private refcounts = new Map<GenerationId, number>();
  private useSymlink: boolean | null = null;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.currentPath = path.join(rootDir, 'current');
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  /** The most recently allocated generation id (0 if none published yet). */
  get currentCounter(): GenerationId {
    return this.counter;
  }

  /**
   * Resolve the current generation without pinning it.
   * Returns null if no generation has been published yet.
   */
  current(): Generation | null {
    const id = this.readCurrentId();
    if (id === null) return null;
    return { id, dir: this.genDir(id) };
  }

  /**
   * Atomically resolve the current generation AND pin it (refcount++).
   * The caller MUST call `release(id)` when the run finishes.
   */
  acquireCurrent(): Generation | null {
    const gen = this.current();
    if (!gen) return null;
    this.refcounts.set(gen.id, (this.refcounts.get(gen.id) ?? 0) + 1);
    return gen;
  }

  release(id: GenerationId): void {
    const c = this.refcounts.get(id);
    if (c === undefined) return;
    if (c <= 1) {
      this.refcounts.delete(id);
    } else {
      this.refcounts.set(id, c - 1);
    }
  }

  /**
   * Publish a new generation. `writeFn` writes all wrapper files into the
   * provided directory. The generation only becomes visible once `writeFn`
   * completes and the `current` pointer is atomically flipped.
   */
  async publish(
    writeFn: (genDir: string) => Promise<void>
  ): Promise<PublishedGeneration> {
    const id = ++this.counter;
    const genDir = this.genDir(id);
    const tmpDir = `${genDir}.tmp`;

    // Remove any stale .tmp from a crashed prior publish
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    await writeFn(tmpDir);

    // Promote the complete dir atomically (POSIX rename is atomic)
    await rm(genDir, { recursive: true, force: true });
    await rename(tmpDir, genDir);

    // Atomically flip the `current` pointer
    await this.flipCurrent(id);

    return { id, dir: genDir };
  }

  /**
   * Garbage-collect generation dirs (and their bundle caches) that have no
   * outstanding pin and are not current. Returns the ids that were removed.
   */
  async gc(): Promise<GenerationId[]> {
    const currentId = this.readCurrentId();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const removed: GenerationId[] = [];

    for (const entry of entries) {
      const m = /^gen-(\d+)$/.exec(entry.name);
      if (!m) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const id = Number(m[1]);
      if (id === currentId) continue;
      if ((this.refcounts.get(id) ?? 0) > 0) continue;

      await rm(path.join(this.rootDir, entry.name), {
        recursive: true,
        force: true,
      });
      await rm(path.join(BUNDLE_CACHE_ROOT, entry.name), {
        recursive: true,
        force: true,
      });
      removed.push(id);
    }

    return removed;
  }

  private genDir(id: GenerationId): string {
    return path.join(this.rootDir, `gen-${id}`);
  }

  private readCurrentId(): GenerationId | null {
    // Try symlink first
    try {
      const target = fs.readlinkSync(this.currentPath);
      const base = path.basename(path.resolve(this.rootDir, target));
      const m = /^gen-(\d+)$/.exec(base);
      if (m) return Number(m[1]);
    } catch {
      // not a symlink or missing — try pointer file
    }

    try {
      const text = fs.readFileSync(this.currentPath, 'utf8').trim();
      const m = /^gen-(\d+)$/.exec(text);
      if (m) return Number(m[1]);
    } catch {
      // missing entirely
    }

    return null;
  }

  private async flipCurrent(id: GenerationId): Promise<void> {
    const target = `gen-${id}`;
    const tmpPath = `${this.currentPath}.tmp`;

    // Try symlink flip (atomic via rename). Falls back to a pointer file
    // when symlinks are unavailable (e.g. Windows without developer mode).
    if (this.useSymlink !== false) {
      try {
        await rm(tmpPath, { force: true });
        await symlink(target, tmpPath);
        await rename(tmpPath, this.currentPath);
        this.useSymlink = true;
        return;
      } catch {
        this.useSymlink = false;
      }
    }

    // Pointer-file fallback (atomic via rename)
    await writeFile(tmpPath, target, 'utf8');
    await rename(tmpPath, this.currentPath);
  }
}
