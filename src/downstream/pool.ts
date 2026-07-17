import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { DOWNSTREAM_SERVERS, type DownstreamServer } from './servers.js';
import { ATTR } from '../telemetry/attributes.js';
import {
  recordDownstreamReconnect,
  registerDownstreamGauges,
} from '../telemetry/metrics.js';
import { getTracer, recordException, withSpan } from '../telemetry/tracing.js';

export class DownstreamUnavailableError extends Error {
  constructor(public readonly server: string) {
    super(`Downstream server not connected: ${server}`);
    this.name = 'DownstreamUnavailableError';
  }
}

type ServerState = {
  config: DownstreamServer;
  client: Client;
  transport: StdioClientTransport;
  connected: boolean;
  restarting: boolean;
};

function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
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
        console.error('[downstream] server failed to start:', r.reason);
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
          env: buildChildEnv(config.env),
        });

        transport.onclose = () => {
          console.warn('[downstream] disconnected:', config.name);
          void this.handleServerFailure(config.name);
        };

        transport.onerror = (err: Error) => {
          console.error('[downstream] error:', config.name, err);
          void this.handleServerFailure(config.name);
        };

        await client.connect(transport);

        this.servers.set(config.name, {
          config,
          client,
          transport,
          connected: true,
          restarting: false,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        console.error(`[downstream] connected: ${config.name}`);
      }
    );
  }

  private async handleServerFailure(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state || state.restarting) return;

    state.restarting = true;
    state.connected = false;
    console.warn('[downstream] restarting:', name);

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
        console.error('[downstream] reconnected:', name);
        this.notifyChange();
        return;
      } catch (err) {
        console.error(`[downstream] restart failed (${attempt}/5)`, err);
        recordException(span, err);
        span.setAttribute(ATTR.RECONNECT_OUTCOME, 'failure');
        span.end();
        recordDownstreamReconnect(name, 'failure');
        void reconnectStart;
      }
    }

    recordDownstreamReconnect(name, 'gave_up');
    console.error('[downstream] giving up on:', name);
  }

  getClient(name: string): Client {
    const state = this.servers.get(name);
    if (!state || !state.connected) {
      throw new DownstreamUnavailableError(name);
    }
    return state.client;
  }

  async listTools(serverName: string) {
    const client = this.getClient(serverName);
    const result = await client.listTools();
    return result.tools;
  }
}
