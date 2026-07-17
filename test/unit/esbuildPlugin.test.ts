import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mcpResolverPlugin } from '../../src/exec/esbuildPlugin.js';

describe('mcpResolverPlugin', () => {
  it('resolves mcp/* to wrappersDir with .ts extension', () => {
    const wrappersDir = '/tmp/test-wrappers';
    const plugin = mcpResolverPlugin(wrappersDir);

    const captured: Array<{
      filter: RegExp;
      callback: (args: { path: string }) => { path: string };
    }> = [];
    const mockBuild = {
      onResolve(
        options: { filter: RegExp },
        callback: (args: { path: string }) => { path: string }
      ) {
        captured.push({ filter: options.filter, callback });
      },
    };

    plugin.setup(mockBuild as any);

    expect(captured).toHaveLength(1);
    expect(captured[0].filter.test('mcp/servers/filesystem/readFile')).toBe(
      true
    );
    expect(captured[0].filter.test('not-mcp/foo')).toBe(false);

    const result = captured[0].callback({
      path: 'mcp/servers/filesystem/readFile',
    });
    expect(result).toEqual({
      path: path.join(wrappersDir, 'servers/filesystem/readFile.ts'),
    });
  });
});
