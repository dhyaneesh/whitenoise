// src/telemetry/attributes.ts
import { createHash } from 'node:crypto';

/** Bounded outcome labels for metrics and span attributes. */
export type Outcome =
  | 'success'
  | 'tool_error'
  | 'protocol_error'
  | 'timeout'
  | 'downstream_unavailable'
  | 'queue_full'
  | 'worker_crash'
  | 'compilation_error'
  | 'module_not_found'
  | 'runtime_error'
  | 'error';

export type RecycleReason = 'max_runs' | 'timeout' | 'crash' | 'nonzero_exit';

export const ATTR = {
  MCP_METHOD_NAME: 'mcp.method.name',
  GEN_AI_TOOL_NAME: 'gen_ai.tool.name',
  META_TOOL_NAME: 'whitenoise.meta_tool.name',
  REQUEST_TIMEOUT_MS: 'whitenoise.request.timeout_ms',

  CODE_BYTES: 'whitenoise.code.bytes',
  CODE_SHA256: 'whitenoise.code.sha256',
  CODE_LINE_COUNT: 'whitenoise.code.line_count',
  CODE_IMPORT_COUNT: 'whitenoise.code.import_count',
  RESPONSE_BYTES: 'whitenoise.response.bytes',

  WORKER_SLOT_ID: 'whitenoise.worker.slot_id',
  BUNDLE_CACHE_HIT: 'whitenoise.bundle.cache_hit',
  BUNDLE_OUTPUT_BYTES: 'whitenoise.bundle.output_bytes',

  DOWNSTREAM_SERVER: 'whitenoise.downstream.server',
  TOOL_CALL_ID: 'whitenoise.tool.call_id',
  TOOL_ARGUMENTS_BYTES: 'whitenoise.tool.arguments.bytes',
  TOOL_RESULT_BYTES: 'whitenoise.tool.result.bytes',
  TOOL_RESULT_IS_ERROR: 'whitenoise.tool.result.is_error',
  TOOL_SEQUENCE: 'whitenoise.tool.sequence_number',
  TOOL_OUTCOME: 'whitenoise.tool.outcome',

  SEARCH_QUERY_LENGTH: 'whitenoise.search.query.length',
  SEARCH_QUERY_WORD_COUNT: 'whitenoise.search.query.word_count',
  SEARCH_LIMIT: 'whitenoise.search.limit',
  SEARCH_RESULT_COUNT: 'whitenoise.search.result_count',
  SEARCH_TOP_SCORE: 'whitenoise.search.top_score',
  SEARCH_ZERO_MATCH: 'whitenoise.search.zero_match',
  SEARCH_FALLBACK_USED: 'whitenoise.search.fallback_used',

  MODULE_SPECIFIER: 'whitenoise.module.specifier',
  MODULE_SOURCE_BYTES: 'whitenoise.module.source_bytes',

  EXECUTION_IMPORT_COUNT: 'whitenoise.execution.import_count',
  EXECUTION_IMPORTED_TOOL_COUNT: 'whitenoise.execution.imported_tool_count',
  EXECUTION_UNIQUE_SERVER_COUNT: 'whitenoise.execution.unique_server_count',
  EXECUTION_DOWNSTREAM_CALL_COUNT: 'whitenoise.execution.downstream_call_count',
  EXECUTION_ROUND_TRIPS_AVOIDED: 'whitenoise.execution.round_trips_avoided',
  INTERMEDIATE_RESULT_BYTES: 'whitenoise.intermediate_result.bytes',
  FINAL_RESULT_BYTES: 'whitenoise.final_result.bytes',

  STDOUT_TRUNCATED: 'whitenoise.execution.stdout_truncated',
  STDERR_TRUNCATED: 'whitenoise.execution.stderr_truncated',

  ERROR_TYPE: 'whitenoise.error.type',
  OUTCOME: 'whitenoise.outcome',

  CATALOG_TOOL_COUNT: 'whitenoise.catalog.tool_count',
  CATALOG_DEFINITION_BYTES: 'whitenoise.catalog.definition_bytes',
  CATALOG_SERVER_COUNT: 'whitenoise.catalog.server_count',
  CATALOG_PARTIAL: 'whitenoise.catalog.refresh.partial',
  CATALOG_FAILED_SERVERS: 'whitenoise.catalog.refresh.failed_servers',

  WRAPPER_TOOL_COUNT: 'whitenoise.wrapper.tool_count',
  WRAPPER_SERVER_COUNT: 'whitenoise.wrapper.server_count',
  WRAPPER_FILE_COUNT: 'whitenoise.wrapper.file_count',

  RECONNECT_ATTEMPT: 'whitenoise.downstream.reconnect.attempt',
  RECONNECT_OUTCOME: 'whitenoise.downstream.reconnect.outcome',
} as const;

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function byteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8');
}

export function lineCount(code: string): number {
  if (!code) return 0;
  return code.split(/\r?\n/).length;
}

/** Count `mcp/...` import specifiers in submitted source. */
export function countMcpImports(code: string): {
  importCount: number;
  toolCount: number;
  uniqueServers: number;
} {
  const re =
    /(?:from|import)\s+['"]mcp\/servers\/([^/'"]+)\/([^/'"]+)['"]/g;
  const servers = new Set<string>();
  let toolCount = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    servers.add(match[1]!);
    toolCount += 1;
  }
  // Also catch bare mcp/ imports (bridge, etc.)
  const anyMcp = code.match(/(?:from|import)\s+['"]mcp\/[^'"]+['"]/g) ?? [];
  return {
    importCount: anyMcp.length,
    toolCount,
    uniqueServers: servers.size,
  };
}

export function jsonByteLength(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}
