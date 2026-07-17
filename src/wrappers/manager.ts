import path from 'node:path';
import os from 'node:os';
import { rm, mkdir } from 'node:fs/promises';
import type { ToolCatalog } from '../downstream/catalog.js';
import { generateWrappers } from './generate.js';
import { ATTR } from '../telemetry/attributes.js';
import { recordWrapperGenerated } from '../telemetry/metrics.js';
import { withSpan } from '../telemetry/tracing.js';

const baseTmp = path.join(os.tmpdir(), 'meta-mcp-proxy');
export const wrappersDir = path.join(baseTmp, 'wrappers');

export async function prepareWrappers(catalog: ToolCatalog): Promise<void> {
  // Clean entire base temp directory to remove stale leftovers from crashes
  await rm(baseTmp, { recursive: true, force: true }).catch(() => {});
  await mkdir(wrappersDir, { recursive: true });

  await generateWrappersInstrumented(catalog);
}

/**
 * Regenerate wrappers without nuking the entire baseTmp directory.
 * Safe to call during hot reload - preserves execution sandboxes.
 */
export async function regenerateWrappers(catalog: ToolCatalog): Promise<void> {
  // Only clear wrappers dir, not the entire baseTmp (preserves sandbox isolation)
  await rm(wrappersDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(wrappersDir, { recursive: true });

  await generateWrappersInstrumented(catalog);
}

async function generateWrappersInstrumented(
  catalog: ToolCatalog
): Promise<void> {
  await withSpan('whitenoise.wrapper.generate', undefined, async (span) => {
    const result = await generateWrappers(wrappersDir, catalog);
    span.setAttribute(ATTR.WRAPPER_TOOL_COUNT, result.toolCount);
    span.setAttribute(ATTR.WRAPPER_SERVER_COUNT, result.serverCount);
    span.setAttribute(ATTR.WRAPPER_FILE_COUNT, result.fileCount);
    recordWrapperGenerated(result.fileCount);
  });
}
