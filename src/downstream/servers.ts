import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export type ToolPolicy = {
  timeoutMs: number;
  maxResultBytes: number;
};

export type ToolPolicies = Record<
  string,
  { timeoutMs?: number; maxResultBytes?: number }
>;

export type DownstreamServer = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  toolPolicies?: ToolPolicies;
  envPassthrough?: string[];
};

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESULT_BYTES = 5 * 1024 * 1024; // 5 MB

/** Resolve the effective policy for a tool, merging wildcard (`*`) with specific. */
export function resolveToolPolicy(
  policies: ToolPolicies | undefined,
  tool: string
): ToolPolicy {
  const specific = policies?.[tool];
  const wildcard = policies?.['*'];
  return {
    timeoutMs:
      specific?.timeoutMs ??
      wildcard?.timeoutMs ??
      DEFAULT_TOOL_TIMEOUT_MS,
    maxResultBytes:
      specific?.maxResultBytes ??
      wildcard?.maxResultBytes ??
      DEFAULT_MAX_RESULT_BYTES,
  };
}

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '')
              .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? '');
}

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

  let toolPolicies: ToolPolicies | undefined;
  if (obj.toolPolicies !== undefined) {
    if (typeof obj.toolPolicies !== 'object' || obj.toolPolicies === null) {
      throw new Error(`servers.json[${index}]: "toolPolicies" must be an object if provided`);
    }
    toolPolicies = {};
    for (const [toolName, policy] of Object.entries(
      obj.toolPolicies as Record<string, unknown>
    )) {
      if (typeof policy !== 'object' || policy === null) {
        throw new Error(`servers.json[${index}]: toolPolicies["${toolName}"] must be an object`);
      }
      const p = policy as Record<string, unknown>;
      const entry: { timeoutMs?: number; maxResultBytes?: number } = {};
      if (p.timeoutMs !== undefined) {
        if (typeof p.timeoutMs !== 'number' || p.timeoutMs <= 0) {
          throw new Error(`servers.json[${index}]: toolPolicies["${toolName}"].timeoutMs must be a positive number`);
        }
        entry.timeoutMs = p.timeoutMs;
      }
      if (p.maxResultBytes !== undefined) {
        if (typeof p.maxResultBytes !== 'number' || p.maxResultBytes <= 0) {
          throw new Error(`servers.json[${index}]: toolPolicies["${toolName}"].maxResultBytes must be a positive number`);
        }
        entry.maxResultBytes = p.maxResultBytes;
      }
      toolPolicies[toolName] = entry;
    }
  }

  let envPassthrough: string[] | undefined;
  if (obj.envPassthrough !== undefined) {
    if (!Array.isArray(obj.envPassthrough)) {
      throw new Error(`servers.json[${index}]: "envPassthrough" must be an array of strings`);
    }
    for (const v of obj.envPassthrough) {
      if (typeof v !== 'string') {
        throw new Error(`servers.json[${index}]: "envPassthrough" must only contain strings`);
      }
    }
    envPassthrough = obj.envPassthrough as string[];
  }

  const expandedEnv = obj.env
    ? Object.fromEntries(
        Object.entries(obj.env as Record<string, string>).map(([k, v]) => [
          k,
          expandEnvVars(v),
        ])
      )
    : undefined;

  return {
    name: obj.name,
    command: obj.command,
    args: obj.args.map((a) => (a.includes('$PROJECT_ROOT') ? a.replaceAll('$PROJECT_ROOT', PROJECT_ROOT) : a)),
    ...(expandedEnv ? { env: expandedEnv } : {}),
    ...(toolPolicies ? { toolPolicies } : {}),
    ...(envPassthrough ? { envPassthrough } : {}),
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
