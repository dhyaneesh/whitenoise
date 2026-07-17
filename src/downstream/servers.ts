import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export type DownstreamServer = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

function readConfig(): unknown {
  const configPath = path.resolve(__dirname, 'servers.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

function validateServer(entry: unknown, index: number): DownstreamServer {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`servers.json[${index}]: must be an object`);
  }

  const obj = entry as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error(`servers.json[${index}]: "name" must be a non-empty string`);
  }
  if (typeof obj.command !== 'string' || !obj.command) {
    throw new Error(`servers.json[${index}]: "command" must be a non-empty string`);
  }
  if (!Array.isArray(obj.args)) {
    throw new Error(`servers.json[${index}]: "args" must be an array`);
  }
  for (const arg of obj.args) {
    if (typeof arg !== 'string') {
      throw new Error(`servers.json[${index}]: "args" must only contain strings`);
    }
  }
  if (obj.env !== undefined && (typeof obj.env !== 'object' || obj.env === null)) {
    throw new Error(`servers.json[${index}]: "env" must be an object if provided`);
  }

  return {
    name: obj.name,
    command: obj.command,
    args: obj.args.map((a) => (a === '$PROJECT_ROOT' ? PROJECT_ROOT : a)),
    ...(obj.env ? { env: obj.env as Record<string, string> } : {}),
  };
}

function loadServers(): DownstreamServer[] {
  const config = readConfig();

  if (!config || typeof config !== 'object') {
    throw new Error('servers.json: root must be an object');
  }

  const entries = (config as Record<string, unknown>).servers;
  if (!Array.isArray(entries)) {
    throw new Error('servers.json: "servers" must be an array');
  }

  return entries.map((entry, i) => validateServer(entry, i));
}

export const DOWNSTREAM_SERVERS: DownstreamServer[] = loadServers();
