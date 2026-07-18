// src/exec/classify.ts
import type { WorkerErrorType } from './protocol.js';

export type CompilerErrorDetail = {
  file?: string;
  line?: number;
  column?: number;
  text: string;
};

export type ClassifiedWorkerError = {
  type: WorkerErrorType;
  message: string;
  details?: CompilerErrorDetail[];
};

const MAX_DETAILS = 5;
const MAX_DETAIL_TEXT = 200;

/**
 * Classify an error thrown during a worker run into a typed WorkerErrorType.
 *
 * Only genuine esbuild build failures are classified as COMPILATION_ERROR.
 * Runtime failures (including downstream API errors whose text happens to
 * contain "Error:") must NOT be mislabelled as compilation errors, otherwise
 * platform-vs-user SLO separation breaks.
 */
export function classifyWorkerError(err: unknown): ClassifiedWorkerError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown worker error';

  if (/hard timeout/i.test(message)) {
    return { type: 'HARD_TIMEOUT', message };
  }

  // esbuild BuildFailure carries an errors[] array; name is 'BuildFailure';
  // its message begins with "Build failed with N error(s):" or "Transform failed".
  const anyErr = err as { errors?: unknown[]; name?: string };
  if (
    Array.isArray(anyErr?.errors) ||
    anyErr?.name === 'BuildFailure' ||
    /^Build failed/i.test(message) ||
    /^Transform failed/i.test(message)
  ) {
    const details = extractEsbuildDetails(anyErr?.errors ?? []);
    return { type: 'COMPILATION_ERROR', message, details };
  }

  if (
    /Cannot find module|MODULE_NOT_FOUND|ENOENT|ERR_MODULE_NOT_FOUND/i.test(
      message
    )
  ) {
    return { type: 'MODULE_NOT_FOUND', message };
  }

  return { type: 'RUNTIME_ERROR', message };
}

function extractEsbuildDetails(errors: unknown[]): CompilerErrorDetail[] | undefined {
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const out: CompilerErrorDetail[] = [];
  for (const e of errors) {
    if (out.length >= MAX_DETAILS) break;
    const obj = e as { text?: string; location?: { file?: string; line?: number; column?: number } };
    if (!obj || typeof obj !== 'object') continue;
    const text = typeof obj.text === 'string' ? obj.text.slice(0, MAX_DETAIL_TEXT) : '';
    const loc = obj.location;
    out.push({
      ...(loc?.file ? { file: loc.file } : {}),
      ...(typeof loc?.line === 'number' ? { line: loc.line } : {}),
      ...(typeof loc?.column === 'number' ? { column: loc.column } : {}),
      text,
    });
  }
  return out.length > 0 ? out : undefined;
}
