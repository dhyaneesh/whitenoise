import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { wrappersDir } from './manager.js';

function toSpecifier(filePath: string, rootDir: string): string {
  const rel = path.relative(rootDir, filePath);
  return 'mcp/' + rel.replace(/\\/g, '/').replace(/\.ts$/, '');
}

async function walkDirectory(dir: string, rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recursively walk subdirectories
      const subResults = await walkDirectory(fullPath, rootDir);
      results.push(...subResults);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      // Only include .ts files (actual tool modules)
      results.push(toSpecifier(fullPath, rootDir));
    }
  }

  return results;
}

export async function listModules(
  subPath = '',
  baseDir = wrappersDir
): Promise<string[]> {
  const dir = path.join(baseDir, subPath);
  // Always list all .ts files recursively
  return walkDirectory(dir, baseDir);
}

export async function readModule(
  specifier: string,
  baseDir = wrappersDir
): Promise<string> {
  if (!specifier.startsWith('mcp/')) {
    throw new Error(`Invalid module specifier: ${specifier}`);
  }

  const rel = specifier.slice('mcp/'.length);
  const filePath = path.join(baseDir, rel + '.ts');

  const s = await stat(filePath);
  if (!s.isFile()) {
    throw new Error(`Not a file: ${specifier}`);
  }

  return readFile(filePath, 'utf8');
}
