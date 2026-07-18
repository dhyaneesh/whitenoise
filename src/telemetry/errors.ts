// src/telemetry/errors.ts
import type { WorkerErrorType } from '../exec/protocol.js';
import type { CompilerErrorDetail } from '../exec/protocol.js';

export type ExecutionErrorType =
  | 'COMPILATION_ERROR'
  | 'MODULE_NOT_FOUND'
  | 'INPUT_VALIDATION_ERROR'
  | 'DOWNSTREAM_TOOL_ERROR'
  | 'DOWNSTREAM_UNAVAILABLE'
  | 'EXECUTION_TIMEOUT'
  | 'QUEUE_FULL'
  | 'WORKER_CRASH'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'RUNTIME_ERROR'
  | 'HARD_TIMEOUT'
  | 'SHUTTING_DOWN'
  | 'UNKNOWN_ERROR';

export type ClassifiedError = {
  type: ExecutionErrorType;
  message: string;
  recoverable: boolean;
  details?: CompilerErrorDetail[];
};

const RECOVERABLE: ReadonlySet<ExecutionErrorType> = new Set([
  'COMPILATION_ERROR',
  'MODULE_NOT_FOUND',
  'INPUT_VALIDATION_ERROR',
  'DOWNSTREAM_TOOL_ERROR',
  'DOWNSTREAM_UNAVAILABLE',
  'EXECUTION_TIMEOUT',
  'RUNTIME_ERROR',
  'OUTPUT_LIMIT_EXCEEDED',
]);

/** Error thrown when the worker reports a typed failure. */
export class WorkerExecutionError extends Error {
  constructor(
    public readonly errorType: WorkerErrorType,
    message: string,
    public readonly details?: CompilerErrorDetail[]
  ) {
    super(message);
    this.name = 'WorkerExecutionError';
  }
}

export function isRecoverable(type: ExecutionErrorType): boolean {
  return RECOVERABLE.has(type);
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

export function classifyExecutionError(err: unknown): ClassifiedError {
  const name = errorName(err);
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown error';

  if (name === 'QueueFullError') {
    return { type: 'QUEUE_FULL', message, recoverable: false };
  }
  if (name === 'ExecutionTimeoutError') {
    return { type: 'EXECUTION_TIMEOUT', message, recoverable: true };
  }
  if (name === 'WorkerCrashedError') {
    return { type: 'WORKER_CRASH', message, recoverable: false };
  }
  if (name === 'DownstreamUnavailableError') {
    return { type: 'DOWNSTREAM_UNAVAILABLE', message, recoverable: true };
  }
  if (err instanceof WorkerExecutionError) {
    return {
      type: err.errorType,
      message: err.message,
      recoverable: isRecoverable(err.errorType),
      ...(err.details ? { details: err.details } : {}),
    };
  }

  if (message === 'Proxy shutting down' || /shutting down/i.test(message)) {
    return { type: 'SHUTTING_DOWN', message, recoverable: false };
  }

  return { type: 'UNKNOWN_ERROR', message, recoverable: false };
}

export function modelFacingErrorPayload(err: unknown): ClassifiedError {
  return classifyExecutionError(err);
}
