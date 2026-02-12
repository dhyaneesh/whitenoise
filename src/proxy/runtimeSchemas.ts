// src/proxy/runtimeSchemas.ts
import { z } from 'zod';

/**
 * Canonical MCP success envelope
 */
export const MCPSuccessSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string(),
    })
  ).optional(),

  structuredContent: z.unknown().optional(),
});

/**
 * Canonical MCP error envelope
 */
export const MCPErrorSchema = z.object({
  isError: z.literal(true),
  content: z.array(
    z.object({
      type: z.literal('text'),
      text: z.string(),
    })
  ),
});

/**
 * Union type returned by *all* tool calls
 */
export const MCPResultSchema = z.union([
  MCPSuccessSchema,
  MCPErrorSchema,
]);

export type MCPSuccess = z.infer<typeof MCPSuccessSchema>;
export type MCPError = z.infer<typeof MCPErrorSchema>;
export type MCPResult = z.infer<typeof MCPResultSchema>;
