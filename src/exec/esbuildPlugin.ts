// src/exec/esbuildPlugin.ts
import type { Plugin } from 'esbuild';
import path from 'node:path';

export function mcpResolverPlugin(wrappersDir: string): Plugin {
  return {
    name: 'mcp-resolver',
    setup(build) {
      // Resolve mcp/* to wrappersDir
      build.onResolve({ filter: /^mcp\// }, (args) => {
        const rel = args.path.replace(/^mcp\//, '');
        return {
          path: path.join(wrappersDir, rel + '.ts'),
        };
      });
    },
  };
}
