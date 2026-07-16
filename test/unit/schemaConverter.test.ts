import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  jsonSchemaToZod,
  jsonSchemaToSource,
  zodToSource,
} from '../../src/downstream/schemaConverter.js';
import { sampleObjectSchema } from '../helpers/fixtures.js';

function evalSource(source: string): z.ZodTypeAny {
  // eslint-disable-next-line no-new-func
  return new Function('z', `return (${source})`)(z) as z.ZodTypeAny;
}

describe('jsonSchemaToZod', () => {
  it('converts primitives', () => {
    expect(jsonSchemaToZod({ type: 'string' }).parse('hi')).toBe('hi');
    expect(jsonSchemaToZod({ type: 'number' }).parse(3.5)).toBe(3.5);
    expect(jsonSchemaToZod({ type: 'integer' }).parse(3)).toBe(3);
    expect(jsonSchemaToZod({ type: 'boolean' }).parse(true)).toBe(true);
    expect(jsonSchemaToZod({ type: 'null' }).parse(null)).toBe(null);
  });

  it('converts string enums', () => {
    const schema = jsonSchemaToZod({ enum: ['a', 'b'] });
    expect(schema.parse('a')).toBe('a');
    expect(() => schema.parse('c')).toThrow();
  });

  it('converts const to literal', () => {
    const schema = jsonSchemaToZod({ const: 'fixed' });
    expect(schema.parse('fixed')).toBe('fixed');
    expect(() => schema.parse('other')).toThrow();
  });

  it('converts anyOf / oneOf to unions', () => {
    const anyOf = jsonSchemaToZod({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(anyOf.parse('x')).toBe('x');
    expect(anyOf.parse(1)).toBe(1);

    const oneOf = jsonSchemaToZod({
      oneOf: [{ type: 'boolean' }, { type: 'null' }],
    });
    expect(oneOf.parse(false)).toBe(false);
    expect(oneOf.parse(null)).toBe(null);
  });

  it('approximates allOf as intersection', () => {
    const schema = jsonSchemaToZod({
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
        },
        {
          type: 'object',
          properties: { b: { type: 'number' } },
          required: ['b'],
        },
      ],
    });
    expect(schema.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 });
  });

  it('resolves local $ref', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        item: { $ref: '#/definitions/Item' },
      },
      required: ['item'],
      definitions: {
        Item: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    });
    expect(schema.parse({ item: { id: '1' } })).toEqual({ item: { id: '1' } });
  });

  it('marks non-required fields optional and preserves required', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        must: { type: 'string' },
        maybe: { type: 'string' },
      },
      required: ['must'],
    });
    expect(schema.parse({ must: 'a' })).toEqual({ must: 'a' });
    expect(() => schema.parse({})).toThrow();
  });

  it('honors additionalProperties: false (strict)', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(schema.parse({ a: 'x' })).toEqual({ a: 'x' });
    expect(() => schema.parse({ a: 'x', extra: 1 })).toThrow();
  });

  it('applies string and number constraints', () => {
    const str = jsonSchemaToZod({
      type: 'string',
      minLength: 2,
      maxLength: 4,
      pattern: '^[a-z]+$',
    });
    expect(str.parse('ab')).toBe('ab');
    expect(() => str.parse('A')).toThrow();

    const num = jsonSchemaToZod({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
    expect(num.parse(5)).toBe(5);
    expect(() => num.parse(0)).toThrow();
  });

  it('supports nullable', () => {
    const schema = jsonSchemaToZod({ type: 'string', nullable: true });
    expect(schema.parse('x')).toBe('x');
    expect(schema.parse(null)).toBe(null);
  });

  it('attaches description and default via withMeta', () => {
    const schema = jsonSchemaToZod({
      type: 'string',
      description: 'A label',
      default: 'hi',
    });
    expect(schema.description).toBe('A label');
    // default makes input optional at parse time when missing
    expect(schema.parse(undefined)).toBe('hi');
  });
});

describe('jsonSchemaToSource', () => {
  it('emits source that evaluates to an equivalent Zod schema', () => {
    const source = jsonSchemaToSource(sampleObjectSchema);
    const live = evalSource(source);

    expect(live.parse({ name: 'ok', status: 'pending' })).toMatchObject({
      name: 'ok',
      status: 'pending',
    });
    expect(() => live.parse({})).toThrow();
  });

  it('preserves describe / default / optional fragments', () => {
    const source = jsonSchemaToSource({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        content: {
          type: 'string',
          description: 'File contents',
          default: '',
        },
      },
      required: ['path'],
    });

    expect(source).toContain('.describe("Absolute path to the file to read")');
    expect(source).toContain('.describe("File contents")');
    expect(source).toContain('.default("")');
    expect(source).toContain('.optional()');
  });

  it('emits enum, union, and array forms', () => {
    expect(jsonSchemaToSource({ enum: ['a', 'b'] })).toContain('z.enum([');
    expect(
      jsonSchemaToSource({
        anyOf: [{ type: 'string' }, { type: 'number' }],
      })
    ).toContain('z.union([');
    expect(
      jsonSchemaToSource({ type: 'array', items: { type: 'string' } })
    ).toBe('z.array(z.string())');
  });
});

describe('zodToSource', () => {
  it('round-trips basic object schemas', () => {
    const schema = z.object({
      name: z.string().describe('Display name'),
      count: z.number().optional(),
    });
    const source = zodToSource(schema);
    expect(source).toContain('z.object({');
    expect(source).toContain('z.string()');
    expect(source).toContain('.optional()');

    const live = evalSource(source);
    expect(live.parse({ name: 'x' })).toEqual({ name: 'x' });
  });
});
