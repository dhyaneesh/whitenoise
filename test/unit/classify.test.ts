import { describe, it, expect } from 'vitest';
import { classifyWorkerError } from '../../src/exec/classify.js';

describe('classifyWorkerError', () => {
  it('classifies esbuild BuildFailure with errors[] as COMPILATION_ERROR', () => {
    const err = Object.assign(new Error('Build failed with 1 error:\nERROR: foo'), {
      name: 'BuildFailure',
      errors: [{ text: 'foo' }],
    });
    expect(classifyWorkerError(err)).toEqual({
      type: 'COMPILATION_ERROR',
      message: err.message,
      details: [{ text: 'foo' }],
    });
  });

  it('extracts structured details from esbuild errors with locations', () => {
    const err = Object.assign(
      new Error('Build failed with 1 error:\nentry.ts:1:0: ERROR: Could not read file'),
      {
        name: 'BuildFailure',
        errors: [
          {
            text: 'Could not read from file: /tmp/x.ts',
            location: { file: '/tmp/entry.ts', line: 1, column: 0 },
          },
        ],
      }
    );
    const result = classifyWorkerError(err);
    expect(result.type).toBe('COMPILATION_ERROR');
    expect(result.details).toEqual([
      { file: '/tmp/entry.ts', line: 1, column: 0, text: 'Could not read from file: /tmp/x.ts' },
    ]);
  });

  it('caps details at 5 entries and truncates text at 200 chars', () => {
    const longText = 'x'.repeat(300);
    const errors = Array.from({ length: 10 }, (_, i) => ({
      text: longText,
      location: { file: `f${i}.ts`, line: i + 1 },
    }));
    const err = Object.assign(new Error('Build failed'), {
      name: 'BuildFailure',
      errors,
    });
    const result = classifyWorkerError(err);
    expect(result.details?.length).toBe(5);
    expect(result.details?.[0].text.length).toBe(200);
  });

  it('classifies a "Build failed with N error(s):" message as COMPILATION_ERROR', () => {
    const err = new Error(
      'Build failed with 1 error:\n../../entry.ts:1:0: ERROR: Could not read from file: /tmp/x.ts'
    );
    expect(classifyWorkerError(err).type).toBe('COMPILATION_ERROR');
  });

  it('does NOT classify "Error: Rate limit exceeded" as COMPILATION_ERROR', () => {
    // Regression: the old /ERROR:/i regex matched "Error:" and mislabelled
    // downstream API rate-limit failures as compilation errors.
    const err = new Error('Error: Rate limit exceeded');
    expect(classifyWorkerError(err).type).toBe('RUNTIME_ERROR');
  });

  it('does NOT classify a generic Error whose message contains "error:" as COMPILATION_ERROR', () => {
    const err = new Error('something failed: error: bad thing');
    expect(classifyWorkerError(err).type).toBe('RUNTIME_ERROR');
  });

  it('classifies ENOENT-style messages as MODULE_NOT_FOUND', () => {
    const err = new Error("Cannot find module 'mcp/servers/x/y'");
    expect(classifyWorkerError(err).type).toBe('MODULE_NOT_FOUND');
  });

  it('classifies ERR_MODULE_NOT_FOUND as MODULE_NOT_FOUND', () => {
    const err = new Error('[ERR_MODULE_NOT_FOUND]: Cannot find package x');
    expect(classifyWorkerError(err).type).toBe('MODULE_NOT_FOUND');
  });

  it('classifies hard-timeout messages as HARD_TIMEOUT', () => {
    const err = new Error('Worker hard timeout exceeded');
    expect(classifyWorkerError(err).type).toBe('HARD_TIMEOUT');
  });

  it('classifies plain runtime errors as RUNTIME_ERROR', () => {
    const err = new Error('expected test error');
    expect(classifyWorkerError(err).type).toBe('RUNTIME_ERROR');
  });

  it('classifies non-Error values using a string fallback', () => {
    expect(classifyWorkerError('boom')).toEqual({
      type: 'RUNTIME_ERROR',
      message: 'boom',
    });
    expect(classifyWorkerError({}).type).toBe('RUNTIME_ERROR');
    expect(classifyWorkerError({}).message).toBe('Unknown worker error');
  });
});
