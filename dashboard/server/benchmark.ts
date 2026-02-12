import { getScenario, type ScenarioStep } from './scenarios.js';
import { estimateTokens } from './tokenCounter.js';

type PoolLike = { getClient: (name: string) => { callTool: (req: { name: string; arguments?: unknown }) => Promise<{ content?: unknown[] }> } };
type ExecMgrLike = { execute: (script: string, opts?: { timeoutMs?: number }) => Promise<{ durationMs: number; stdout: string; stderr: string }> };

const WARMUP = 3;
const MEASURED = 5;

export type RunResult = {
  vanilla: { latencyMs: number; roundTrips: number; tokensTransferred: number };
  whitenoise: { latencyMs: number; roundTrips: number; tokensTransferred: number };
};

async function runVanillaIteration(pool: PoolLike, steps: ScenarioStep[]): Promise<{ latencyMs: number; tokensTransferred: number }> {
  const start = performance.now();
  let tokensTransferred = 0;
  for (const step of steps) {
    const client = pool.getClient(step.server);
    const result = await client.callTool({ name: step.tool, arguments: step.args });
    const resultStr = JSON.stringify(result?.content ?? result);
    tokensTransferred += estimateTokens(resultStr);
  }
  const latencyMs = performance.now() - start;
  return { latencyMs, tokensTransferred };
}

async function runWhiteNoiseIteration(execMgr: ExecMgrLike, code: string): Promise<{ latencyMs: number; tokensTransferred: number }> {
  const result = await execMgr.execute(code, { timeoutMs: 15000 });
  const tokensTransferred = estimateTokens(result.stdout || '') + estimateTokens(result.stderr || '');
  return { latencyMs: result.durationMs, tokensTransferred };
}

function median(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export async function runScenario(pool: PoolLike, execMgr: ExecMgrLike, scenarioId: string): Promise<RunResult> {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);

  const vanillaLatencies: number[] = [];
  const vanillaTokens: number[] = [];
  for (let i = 0; i < WARMUP + MEASURED; i++) {
    const { latencyMs, tokensTransferred } = await runVanillaIteration(pool, scenario.vanillaSteps);
    if (i >= WARMUP) {
      vanillaLatencies.push(latencyMs);
      vanillaTokens.push(tokensTransferred);
    }
  }

  const whitenoiseLatencies: number[] = [];
  const whitenoiseTokens: number[] = [];
  for (let i = 0; i < WARMUP + MEASURED; i++) {
    const { latencyMs, tokensTransferred } = await runWhiteNoiseIteration(execMgr, scenario.whitenoiseCode);
    if (i >= WARMUP) {
      whitenoiseLatencies.push(latencyMs);
      whitenoiseTokens.push(tokensTransferred);
    }
  }

  return {
    vanilla: {
      latencyMs: median(vanillaLatencies),
      roundTrips: scenario.vanillaSteps.length,
      tokensTransferred: Math.round(vanillaTokens.reduce((a, b) => a + b, 0) / vanillaTokens.length),
    },
    whitenoise: {
      latencyMs: median(whitenoiseLatencies),
      roundTrips: 1,
      tokensTransferred: Math.round(whitenoiseTokens.reduce((a, b) => a + b, 0) / whitenoiseTokens.length),
    },
  };
}
