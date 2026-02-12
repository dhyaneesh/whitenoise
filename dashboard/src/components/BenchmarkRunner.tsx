import { useEffect, useState } from 'react';
import { fetchScenarios, runBenchmark, runAllBenchmarks } from '../api';
import type { Scenario } from '../types';
import type { BenchmarkResult } from '../types';
import type { RunAllResultItem } from '../types';
import { ScenarioCard } from './ScenarioCard';

type BenchmarkRunnerProps = {
  onRunAllComplete?: (results: RunAllResultItem[]) => void;
};

export function BenchmarkRunner({ onRunAllComplete }: BenchmarkRunnerProps) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [runAllLoading, setRunAllLoading] = useState(false);
  const [singleResult, setSingleResult] = useState<BenchmarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchScenarios()
      .then((list) => {
        setScenarios(list);
        if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const handleRunOne = async () => {
    if (!selectedId) return;
    setError(null);
    setSingleResult(null);
    setLoading(true);
    try {
      const result = await runBenchmark(selectedId);
      setSingleResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleRunAll = async () => {
    setError(null);
    setRunAllLoading(true);
    try {
      const results = await runAllBenchmarks();
      onRunAllComplete?.(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunAllLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
      <h2 className="mb-4 text-lg font-semibold">Run benchmarks</h2>
      {error && (
        <p className="mb-4 rounded bg-red-900/30 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-sm text-zinc-400">Scenario</label>
          <select
            className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleRunOne}
          disabled={loading || !selectedId}
          className="rounded bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50"
        >
          {loading ? 'Running…' : 'Run one'}
        </button>
        <button
          type="button"
          onClick={handleRunAll}
          disabled={runAllLoading}
          className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-600 disabled:opacity-50"
        >
          {runAllLoading ? 'Running all…' : 'Run all benchmarks'}
        </button>
      </div>
      {singleResult && (
        <div className="mt-6">
          <ScenarioCard
            scenarioId={selectedId}
            scenarioName={scenarios.find((s) => s.id === selectedId)?.name ?? selectedId}
            result={singleResult}
          />
        </div>
      )}
    </div>
  );
}
