import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('postgres-writable-server: please provide a database URL as a command-line argument');
  process.exit(1);
}
const databaseUrl = args[0];

const server = new Server(
  { name: 'whitenoise/postgres-writable', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const pool = new pg.Pool({ connectionString: databaseUrl });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'query',
      description:
        'Run a SQL query against the configured Postgres database. Read and write statements are both allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL statement to execute' },
        },
        required: ['sql'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'query') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const sql = request.params.arguments?.sql;
  if (typeof sql !== 'string') {
    throw new Error('Missing required argument: sql');
  }
  const client = await pool.connect();
  try {
    const result = await client.query(sql);
    return {
      content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }],
      isError: false,
    };
  } finally {
    client.release();
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((err) => {
  console.error('postgres-writable-server failed:', err);
  process.exit(1);
});
