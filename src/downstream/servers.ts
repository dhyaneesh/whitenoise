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
      process.cwd(), // IMPORTANT: allow repo root
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
  {
    name: 'github-mcp-server',
    command: 'npx',
    args: [
      '-y',
      '--package=@0xshariq/github-mcp-server@latest',
      '--',
      'node',
      '--input-type=module',
      '--eval',
      'import("@0xshariq/github-mcp-server/dist/index.js")',
    ],
  },
];
