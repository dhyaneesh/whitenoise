// src/exec/protocol.ts

export type WorkerStage =
  | 'bundle.cache_lookup'
  | 'bundle.context_create'
  | 'bundle.source_write'
  | 'bundle.rebuild'
  | 'bundle.cache_write'
  | 'execution.user_code';

export type WorkerErrorType =
  | 'COMPILATION_ERROR'
  | 'MODULE_NOT_FOUND'
  | 'RUNTIME_ERROR'
  | 'HARD_TIMEOUT';

export type RunMessage = {
  type: 'run';
  id: string;
  payload: {
    script: string;
    wrappersDir: string;
  };
};

export type RunResultMessage = {
  type: 'runResult';
  id: string;
  payload:
    | { ok: true; durationMs: number }
    | {
        ok: false;
        error: {
          type: WorkerErrorType;
          message: string;
        };
      };
};

export type CallToolMessage = {
  type: 'callTool';
  id: string; // toolCallId, NOT runId
  payload: {
    fqTool: string;
    args: unknown;
  };
};

export type CallToolResultMessage = {
  type: 'callToolResult';
  id: string; // matches toolCallId
  payload:
    | { ok: true; result: unknown }
    | { ok: false; error: { message: string; stack?: string } };
};

export type StageMessage = {
  type: 'stage';
  id: string;
  payload: {
    stage: WorkerStage;
    state: 'start' | 'end';
    timestamp: number;
    attributes?: {
      cacheHit?: boolean;
      bundleBytes?: number;
    };
  };
};

export type MainToWorker = RunMessage | CallToolResultMessage;
export type WorkerToMain = CallToolMessage | RunResultMessage | StageMessage;
