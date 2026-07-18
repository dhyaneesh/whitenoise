import { rm, mkdir } from 'node:fs/promises';
import type { Span } from '@opentelemetry/api';
import type { ToolCatalog } from '../downstream/catalog.js';
import { generateWrappers } from './generate.js';
import { GenerationStore } from './generations.js';
import { WRAPPERS_ROOT, BASE_TMP } from '../paths.js';
import { ATTR } from '../telemetry/attributes.js';
import {
  recordWrapperGenerated,
  recordWrapperGeneration,
  recordWrapperSwap,
} from '../telemetry/metrics.js';
import { withSpan } from '../telemetry/tracing.js';

let store: GenerationStore | null = null;

export function getGenerationStore(): GenerationStore {
  if (!store) {
    throw new Error('GenerationStore not initialized — call prepareWrappers first');
  }
  return store;
}

/**
 * Clean the entire base temp directory and publish the first generation.
 * Safe to call only at startup when no readers exist.
 */
export async function prepareWrappers(catalog: ToolCatalog): Promise<void> {
  await rm(BASE_TMP, { recursive: true, force: true }).catch(() => {});
  await mkdir(WRAPPERS_ROOT, { recursive: true });

  store = new GenerationStore(WRAPPERS_ROOT);
  await store.init();

  await publishGeneration(catalog, 'startup');
}

/**
 * Publish a new generation without removing the live one. In-flight
 * executions pin the previous generation via refcount; stale generations
 * are garbage-collected once their refcount drops to zero.
 */
export async function regenerateWrappers(catalog: ToolCatalog): Promise<void> {
  await publishGeneration(catalog, 'hot_reload');
  const removed = await getGenerationStore().gc();
  if (removed.length > 0) {
    console.error(
      `[wrappers] garbage-collected generations: ${removed.join(', ')}`
    );
  }
}

async function publishGeneration(
  catalog: ToolCatalog,
  reason: 'startup' | 'hot_reload'
): Promise<void> {
  const started = Date.now();
  const s = getGenerationStoreSafe();
  let genId = 0;
  let outcome: 'success' | 'failure' = 'success';

  try {
    await withSpan(
      'whitenoise.wrapper.generate',
      undefined,
      async (span) => {
        const result = await s.publish(async (genDir) => {
          await generateWrappersInstrumented(genDir, catalog, span);
        });
        genId = result.id;
        span.setAttribute(ATTR.WRAPPER_GENERATION_ID, result.id);
        span.setAttribute(ATTR.WRAPPER_SWAP_REASON, reason);
        recordWrapperSwap(reason);
      }
    );
  } catch (err) {
    outcome = 'failure';
    genId = s.currentCounter;
    console.error(`[wrappers] generation failed (${reason}):`, err);
    throw err;
  } finally {
    if (genId > 0) {
      recordWrapperGeneration(Date.now() - started, {
        generationId: genId,
        outcome,
      });
    }
  }
}

async function generateWrappersInstrumented(
  genDir: string,
  catalog: ToolCatalog,
  span: Span
): Promise<void> {
  const result = await generateWrappers(genDir, catalog);
  span.setAttribute(ATTR.WRAPPER_TOOL_COUNT, result.toolCount);
  span.setAttribute(ATTR.WRAPPER_SERVER_COUNT, result.serverCount);
  span.setAttribute(ATTR.WRAPPER_FILE_COUNT, result.fileCount);
  recordWrapperGenerated(result.fileCount);
}

function getGenerationStoreSafe(): GenerationStore {
  if (!store) {
    throw new Error('GenerationStore not initialized');
  }
  return store;
}
