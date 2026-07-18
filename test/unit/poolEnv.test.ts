import { describe, it, expect } from 'vitest';
import { DownstreamUnavailableError } from '../../src/downstream/pool.js';
import {
  resolveToolPolicy,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_MAX_RESULT_BYTES,
} from '../../src/downstream/servers.js';

describe('DownstreamPool utilities', () => {
  it('DownstreamUnavailableError carries server name', () => {
    const err = new DownstreamUnavailableError('memory');
    expect(err.server).toBe('memory');
    expect(err.name).toBe('DownstreamUnavailableError');
    expect(err.message).toBe('Downstream server not connected: memory');
  });
});

describe('resolveToolPolicy', () => {
  it('returns defaults when no policies defined', () => {
    const p = resolveToolPolicy(undefined, 'read_file');
    expect(p.timeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(p.maxResultBytes).toBe(DEFAULT_MAX_RESULT_BYTES);
  });

  it('wildcard policy applies to all tools', () => {
    const p = resolveToolPolicy(
      { '*': { timeoutMs: 10_000, maxResultBytes: 1024 } },
      'any_tool'
    );
    expect(p.timeoutMs).toBe(10_000);
    expect(p.maxResultBytes).toBe(1024);
  });

  it('specific policy overrides wildcard', () => {
    const p = resolveToolPolicy(
      {
        '*': { timeoutMs: 30_000, maxResultBytes: 5_000_000 },
        directory_tree: { maxResultBytes: 1_000_000 },
      },
      'directory_tree'
    );
    expect(p.timeoutMs).toBe(30_000); // from wildcard
    expect(p.maxResultBytes).toBe(1_000_000); // from specific
  });

  it('unrelated specific policy does not affect other tools', () => {
    const p = resolveToolPolicy(
      {
        '*': { timeoutMs: 30_000 },
        directory_tree: { maxResultBytes: 1_000_000 },
      },
      'read_file'
    );
    expect(p.maxResultBytes).toBe(DEFAULT_MAX_RESULT_BYTES); // not from directory_tree
  });
});
