import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Resolves to the repo root (two levels up from src/downstream/) */
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export type DownstreamServer = {
  name: string; // stable ID (used in fqTool)
  command: string; // executable
  args: string[]; // stdio MCP server args
  env?: Record<string, string>;
};

// Data-only config. No logic here.
export const DOWNSTREAM_SERVERS: DownstreamServer[] = [
  {
    name: 'filesystem',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-filesystem',
      PROJECT_ROOT, // absolute path — works even when cwd isn't respected
    ],
  },
  {
    name: 'everything',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  },
  {
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  // TODO: re-enable once cwd issue is resolved for --eval imports
  // {
  //   name: 'github-mcp-server',
  //   command: 'npx',
  //   args: [
  //     '-y',
  //     '--package=@0xshariq/github-mcp-server@latest',
  //     '--',
  //     'node',
  //     '--input-type=module',
  //     '--eval',
  //     'import("@0xshariq/github-mcp-server/dist/index.js")',
  //   ],
  // },
];
