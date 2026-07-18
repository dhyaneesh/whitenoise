import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { DOWNSTREAM_SERVERS, type DownstreamServer, resolveToolPolicy, type ToolPolicy } from './servers.js';
import { ATTR } from '../telemetry/attributes.js';
import {
  recordDownstreamConnection,
  recordDownstreamReconnect,
  registerDownstreamGauges,
  recordError,
} from '../telemetry/metrics.js';
import { getTracer, recordException, withSpan } from '../telemetry/tracing.js';

export class DownstreamUnavailableError extends Error {
  constructor(public readonly server: string) {
    super(`Downstream server not connected: ${server}`);
    this.name = 'DownstreamUnavailableError';
  }
}

export class AuthFailureError extends Error {
  constructor(public readonly server: string, message: string) {
    super(`Authentication failed for ${server}: ${message}`);
    this.name = 'AuthFailureError';
  }
}

type ServerState = {
  config: DownstreamServer;
  client: Client;
  transport: StdioClientTransport;
  connected: boolean;
  restarting: boolean;
  authFailed: boolean;
};

/** Environment variables always passed to child processes. */
const ENV_ALLOWLIST = new Set([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot',
  'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_OPTIONS', 'npm_config_cache', 'XDG_CACHE_HOME',
]);

/** Error message patterns indicating a permanent auth failure (not transient). */
const AUTH_ERROR_PATTERNS =
  /(?:^|\b)(401|403|unauthorized|invalid.{0,20}(?:api.?key|token|credential)|bad.{0,20}credential|authentication.{0,20}fail)(?:\b|$)/i;

function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_ERROR_PATTERNS.test(msg);
}

function buildChildEnv(
  extra?: Record<string, string>,
  passthrough?: string[]
): Record<string, string> {
  const env: Record<string, string> = {};
  const allow = new Set(ENV_ALLOWLIST);
  if (passthrough) {
    for (const k of passthrough) allow.add(k);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && allow.has(key)) {
      env[key] = value;
    }
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = value;
    }
  }
  return env;
}

export class DownstreamPool {
  private servers = new Map<string, ServerState>();
  private onChangeCallbacks: Array<() => void | Promise<void>> = [];
  /** Known server names for gauge reporting (including disconnected). */
  private knownServers = new Set<string>(
    DOWNSTREAM_SERVERS.map((s) => s.name)
  );

  constructor() {
    registerDownstreamGauges({
      connectedServers: () =>
        [...this.knownServers].map((server) => ({
          server,
          connected: this.servers.get(server)?.connected ? 1 : 0,
        })),
    });
  }

  onChange(cb: () => void | Promise<void>): void {
    this.onChangeCallbacks.push(cb);
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      Promise.resolve()
        .then(() => cb())
        .catch((err) => {
          console.error('[downstream] onChange error', err);
        });
    }
  }

  getServerNames(): string[] {
    return [...this.servers.keys()];
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      DOWNSTREAM_SERVERS.map((s) => this.startServer(s))
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        if (r.reason instanceof AuthFailureError) {
          console.error(`[downstream] ${r.reason.message} — check credentials/env vars`);
        } else {
          console.error('[downstream] server failed to start:', r.reason);
        }
      }
    }
  }

  async stopAll(): Promise<void> {
    const stops = [...this.servers.values()].map(async (state) => {
      try {
        state.connected = false;
        state.restarting = true;
        await state.client.close();
      } catch (err) {
        console.error('[downstream]', state.config.name, 'close failed', err);
      }
    });
    await Promise.all(stops);
    this.servers.clear();
  }

  private async startServer(config: DownstreamServer): Promise<void> {
    this.knownServers.add(config.name);

    const existing = this.servers.get(config.name);
    if (existing && !existing.restarting) {
      throw new Error(`Duplicate server name: ${config.name}`);
    }
    if (existing?.authFailed) {
      throw new AuthFailureError(config.name, 'server previously failed auth; not retrying');
    }

    const connectStart = Date.now();
    await withSpan(
      'whitenoise.downstream.connection',
      {
        [ATTR.DOWNSTREAM_SERVER]: config.name,
      },
      async (span) => {
        const client = new Client({
          name: 'meta-mcp-proxy',
          version: '0.1.0',
        });

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: buildChildEnv(config.env, config.envPassthrough),
        });

        let lastError: Error | null = null;

        transport.onclose = () => {
          console.warn('[downstream] disconnected:', config.name);
          void this.handleServerFailure(config.name);
        };

        transport.onerror = (err: Error) => {
          console.error('[downstream] error:', config.name, err);
          lastError = err;
          if (isAuthError(err)) {
            const state = this.servers.get(config.name);
            if (state) state.authFailed = true;
          }
          void this.handleServerFailure(config.name);
        };

        try {
          await client.connect(transport);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (isAuthError(lastError)) {
            recordDownstreamConnection(Date.now() - connectStart, {
              server: config.name,
              outcome: 'auth_failed',
            });
            span.setAttribute(ATTR.RECONNECT_OUTCOME, 'auth_failed');
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'auth_failed' });
            recordException(span, lastError);
            throw new AuthFailureError(
              config.name,
              lastError.message
            );
          }
          throw lastError;
        }

        this.servers.set(config.name, {
          config,
          client,
          transport,
          connected: true,
          restarting: false,
          authFailed: false,
        });

        const duration = Date.now() - connectStart;
        recordDownstreamConnection(duration, {
          server: config.name,
          outcome: 'connected',
        });
        span.setStatus({ code: SpanStatusCode.OK });
        console.error(`[downstream] connected: ${config.name} (${duration}ms)`);
      }
    );
  }

  private async handleServerFailure(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state || state.restarting) return;

    state.restarting = true;
    state.connected = false;
    console.warn('[downstream] restarting:', name);

    // Permanent auth failure — don't retry
    if (state.authFailed) {
      recordDownstreamReconnect(name, 'auth_failed');
      recordError({ layer: 'downstream', type: 'auth_failed', server: name });
      console.error(`[downstream] auth failure (permanent): ${name}`);
      this.servers.delete(name);
      this.notifyChange();
      return;
    }

    this.servers.delete(name);
    this.notifyChange();

    for (let attempt = 1; attempt <= 5; attempt++) {
      const reconnectStart = Date.now();
      const span = getTracer().startSpan('whitenoise.downstream.reconnect', {
        attributes: {
          [ATTR.DOWNSTREAM_SERVER]: name,
          [ATTR.RECONNECT_ATTEMPT]: attempt,
        },
      });

      try {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        await this.startServer(state.config);
        span.setAttribute(ATTR.RECONNECT_OUTCOME, 'success');
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        recordDownstreamReconnect(name, 'success');
        console.error(`[downstream] reconnected: ${name} (${Date.now() - reconnectStart}ms)`);
        this.notifyChange();
        return;
      } catch (err) {
        // Auth failure during reconnect — stop retrying
        if (err instanceof AuthFailureError) {
          span.setAttribute(ATTR.RECONNECT_OUTCOME, 'auth_failed');
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'auth_failed' });
          recordException(span, err);
          span.end();
          recordDownstreamReconnect(name, 'auth_failed');
          recordError({ layer: 'downstream', type: 'auth_failed', server: name });
          console.error(`[downstream] auth failure during reconnect (permanent): ${name}`);
          this.notifyChange();
          return;
        }

        console.error(`[downstream] restart failed (${attempt}/5)`, err);
        recordException(span, err);
        span.setAttribute(ATTR.RECONNECT_OUTCOME, 'failure');
        span.end();
        recordDownstreamReconnect(name, 'failure');
      }
    }

    recordDownstreamReconnect(name, 'gave_up');
    recordError({ layer: 'downstream', type: 'reconnect_failed', server: name });
    console.error('[downstream] giving up on:', name);
  }

  getClient(name: string): Client {
    const state = this.servers.get(name);
    if (!state || !state.connected) {
      throw new DownstreamUnavailableError(name);
    }
    return state.client;
  }

  /** Resolve the effective per-tool policy (timeout, max result bytes). */
  getToolPolicy(server: string, tool: string): ToolPolicy {
    const state = this.servers.get(server);
    if (!state) return resolveToolPolicy(undefined, tool);
    return resolveToolPolicy(state.config.toolPolicies, tool);
  }

  async listTools(serverName: string) {
    const client = this.getClient(serverName);
    const result = await client.listTools();
    return result.tools;
  }
}
