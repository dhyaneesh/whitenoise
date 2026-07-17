import { describe, it, expect } from 'vitest';
import { DownstreamUnavailableError } from '../../src/downstream/pool.js';

describe('DownstreamPool utilities', () => {
  it('DownstreamUnavailableError carries server name', () => {
    const err = new DownstreamUnavailableError('memory');
    expect(err.server).toBe('memory');
    expect(err.name).toBe('DownstreamUnavailableError');
    expect(err.message).toBe('Downstream server not connected: memory');
  });
});
