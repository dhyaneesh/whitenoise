import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

export async function makeTempDir(prefix = 'whitenoise-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
