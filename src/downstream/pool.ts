import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DOWNSTREAM_SERVERS, type DownstreamServer } from './servers.js';

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

  onChange(cb: () => void | Promise<void>): void {
    this.onChangeCallbacks.push(cb);
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      // Fire async callbacks without blocking reconnect; contain rejections
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
        state.restarting = true; // Prevent auto-restart during shutdown
        await state.client.close();
      } catch (err) {
        console.error('[downstream]', state.config.name, 'close failed', err);
      }
    });
    await Promise.all(stops);
    this.servers.clear();
  }

  private async startServer(config: DownstreamServer): Promise<void> {
    // Allow restart: only throw if server exists AND is not in restart mode
    const existing = this.servers.get(config.name);
    if (existing && !existing.restarting) {
      throw new Error(`Duplicate server name: ${config.name}`);
    }

    const client = new Client({
      name: 'meta-mcp-proxy',
      version: '0.1.0',
    });

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: buildChildEnv(config.env),
    });

    // Hook disconnect detection
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

    console.error(`[downstream] connected: ${config.name}`);
  }

  private async handleServerFailure(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state || state.restarting) return;

    state.restarting = true;
    state.connected = false;
    console.warn('[downstream] restarting:', name);

    // Remove broken client immediately
    this.servers.delete(name);
    this.notifyChange();

    // Exponential backoff: 1s, 2s, 3s, 4s, 5s
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        await this.startServer(state.config);
        console.error('[downstream] reconnected:', name);
        this.notifyChange();
        return;
      } catch (err) {
        console.error(`[downstream] restart failed (${attempt}/5)`, err);
      }
    }

    console.error('[downstream] giving up on:', name);
  }

  getClient(name: string): Client {
    const state = this.servers.get(name);
    if (!state || !state.connected) {
      throw new Error(`Downstream server not connected: ${name}`);
    }
    return state.client;
  }

  async listTools(serverName: string) {
    const client = this.getClient(serverName);
    const result = await client.listTools();
    return result.tools;
  }
}
