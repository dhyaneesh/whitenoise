// src/paths.ts
import os from 'node:os';
import path from 'node:path';

/**
 * Base temp directory for all WhiteNoise scratch state (wrappers, exec
 * sandboxes, bundle cache). Overridable via WN_BASE_TMP for test isolation.
 */
export const BASE_TMP: string = process.env.WN_BASE_TMP
  ? path.resolve(process.env.WN_BASE_TMP)
  : path.join(os.tmpdir(), 'meta-mcp-proxy');

export const WRAPPERS_ROOT = path.join(BASE_TMP, 'wrappers');
export const EXEC_ROOT = path.join(BASE_TMP, 'exec');
export const BUNDLE_CACHE_ROOT = path.join(EXEC_ROOT, 'cache');
