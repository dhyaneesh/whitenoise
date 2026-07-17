import { describe, it, expect } from 'vitest';
import {
  SearchToolsInput,
  ListModulesInput,
  ReadModuleInput,
  ExecuteCodeInput,
} from '../../src/proxy/toolSchemas.js';
import {
  MCPSuccessSchema,
  MCPErrorSchema,
  MCPResultSchema,
} from '../../src/proxy/runtimeSchemas.js';

describe('toolSchemas', () => {
  it('SearchToolsInput accepts query with optional limit', () => {
    expect(SearchToolsInput.parse({ query: 'read' })).toEqual({
      query: 'read',
    });
    expect(SearchToolsInput.parse({ query: 'read', limit: 10 })).toEqual({
      query: 'read',
      limit: 10,
    });
  });

  it('SearchToolsInput rejects missing query', () => {
    expect(() => SearchToolsInput.parse({})).toThrow();
  });

  it('ListModulesInput accepts optional path', () => {
    expect(ListModulesInput.parse({})).toEqual({});
    expect(
      ListModulesInput.parse({ path: 'servers/filesystem' })
    ).toEqual({
      path: 'servers/filesystem',
    });
  });

  it('ReadModuleInput requires specifier', () => {
    expect(
      ReadModuleInput.parse({ specifier: 'mcp/servers/fs/readFile' })
    ).toEqual({
      specifier: 'mcp/servers/fs/readFile',
    });
    expect(() => ReadModuleInput.parse({})).toThrow();
  });

  it('ExecuteCodeInput requires code with optional timeoutMs', () => {
    expect(
      ExecuteCodeInput.parse({ code: 'console.log(1)' })
    ).toEqual({
      code: 'console.log(1)',
    });
    expect(
      ExecuteCodeInput.parse({
        code: 'console.log(1)',
        timeoutMs: 5000,
      })
    ).toEqual({
      code: 'console.log(1)',
      timeoutMs: 5000,
    });
    expect(() => ExecuteCodeInput.parse({})).toThrow();
  });
});

describe('runtimeSchemas', () => {
  it('MCPSuccessSchema validates a success envelope', () => {
    const ok = MCPSuccessSchema.parse({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(ok.content).toHaveLength(1);
  });

  it('MCPErrorSchema validates an error envelope', () => {
    const err = MCPErrorSchema.parse({
      isError: true,
      content: [{ type: 'text', text: 'fail' }],
    });
    expect(err.isError).toBe(true);
  });

  it('MCPErrorSchema rejects missing isError literal', () => {
    expect(() =>
      MCPErrorSchema.parse({ content: [{ type: 'text', text: 'fail' }] })
    ).toThrow();
  });

  it('MCPResultSchema accepts either success or error', () => {
    expect(() =>
      MCPResultSchema.parse({
        content: [{ type: 'text', text: 'ok' }],
      })
    ).not.toThrow();
    expect(() =>
      MCPResultSchema.parse({
        isError: true,
        content: [{ type: 'text', text: 'fail' }],
      })
    ).not.toThrow();
  });
});
