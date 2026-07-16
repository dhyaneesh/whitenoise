/** Sample JSON Schemas and tool lists for hermetic tests */

export const readFileInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path to the file to read',
    },
  },
  required: ['path'],
};

export const writeFileInputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path to write',
    },
    content: {
      type: 'string',
      description: 'File contents',
      default: '',
    },
  },
  required: ['path'],
};

export type FakeTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

export const filesystemTools: FakeTool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from disk',
    inputSchema: readFileInputSchema,
  },
  {
    name: 'write_file',
    description: 'Write contents to a file on disk',
    inputSchema: writeFileInputSchema,
  },
];

export const memoryTools: FakeTool[] = [
  {
    name: 'create_entities',
    description: 'Create entities in the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: { type: 'object' },
        },
      },
      required: ['entities'],
    },
  },
];

export const sampleObjectSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Display name', minLength: 1 },
    count: { type: 'integer', minimum: 0, maximum: 100 },
    active: { type: 'boolean', default: true },
    tags: {
      type: 'array',
      items: { type: 'string' },
      minItems: 0,
    },
    status: {
      type: 'string',
      enum: ['pending', 'done'],
      description: 'Lifecycle status',
    },
  },
  required: ['name'],
  additionalProperties: false,
};
