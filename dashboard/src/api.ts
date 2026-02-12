import type { Scenario, ContextComparison, BenchmarkResult, RunAllResultItem, LLMRunResult } from './types';

const API = '/api';

export async function fetchScenarios(): Promise<Scenario[]> {
  const res = await fetch(`${API}/benchmark/scenarios`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchContext(): Promise<ContextComparison> {
  const res = await fetch(`${API}/benchmark/context`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runBenchmark(scenarioId: string): Promise<BenchmarkResult> {
  const res = await fetch(`${API}/benchmark/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runAllBenchmarks(): Promise<RunAllResultItem[]> {
  const res = await fetch(`${API}/benchmark/run-all`, { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runVanillaLLM(task: string, model?: string): Promise<LLMRunResult> {
  const res = await fetch(`${API}/llm/run-vanilla`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function runWhiteNoiseLLM(task: string, model?: string): Promise<LLMRunResult> {
  const res = await fetch(`${API}/llm/run-whitenoise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
