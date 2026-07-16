import { describe, it, expect } from 'vitest';
import {
  toCamelCase,
  makeFqTool,
  parseFqTool,
  makeSpecifier,
} from '../../src/downstream/names.js';

describe('names', () => {
  describe('toCamelCase', () => {
    it('converts snake_case tool names', () => {
      expect(toCamelCase('read_file')).toBe('readFile');
      expect(toCamelCase('list_directory')).toBe('listDirectory');
    });

    it('converts kebab-case', () => {
      expect(toCamelCase('create-entities')).toBe('createEntities');
    });

    it('leaves already-camel names alone when no separators', () => {
      expect(toCamelCase('readFile')).toBe('readFile');
    });
  });

  describe('makeFqTool / parseFqTool', () => {
    it('round-trips server and tool', () => {
      const fq = makeFqTool('filesystem', 'read_file');
      expect(fq).toBe('filesystem__read_file');
      expect(parseFqTool(fq)).toEqual({
        server: 'filesystem',
        tool: 'read_file',
      });
    });

    it('throws when __ is missing', () => {
      expect(() => parseFqTool('filesystem_read_file')).toThrow(/Invalid fqTool/);
    });
  });

  describe('makeSpecifier', () => {
    it('builds mcp/servers/<server>/<camelCaseTool>', () => {
      expect(makeSpecifier('filesystem', 'read_file')).toBe(
        'mcp/servers/filesystem/readFile'
      );
    });
  });
});
