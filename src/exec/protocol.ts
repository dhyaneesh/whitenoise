// src/exec/protocol.ts

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
    | { ok: false; error: { message: string; stack?: string } };
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

export type MainToWorker = RunMessage | CallToolResultMessage;
export type WorkerToMain = CallToolMessage | RunResultMessage;
