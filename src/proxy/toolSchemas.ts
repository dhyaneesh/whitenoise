// src/proxy/toolSchemas.ts
import { z } from 'zod';

export const SearchToolsInput = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

export const ListModulesInput = z.object({
  path: z.string().optional(),
});

export const ReadModuleInput = z.object({
  specifier: z.string(),
});

export const ExecuteCodeInput = z.object({
  code: z.string(),
  timeoutMs: z.number().optional(),
});
