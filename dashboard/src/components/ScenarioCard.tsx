import type { BenchmarkResult } from '../types';

type ScenarioCardProps = {
  scenarioId: string;
  scenarioName: string;
  result: BenchmarkResult;
};

export function ScenarioCard({ scenarioName, result }: ScenarioCardProps) {
  return (
    <div className="rounded border border-zinc-700 bg-zinc-800/50 p-4">
      <h3 className="text-sm font-medium text-zinc-300">{scenarioName}</h3>
      <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-red-400">Vanilla</p>
          <p>Latency: {result.vanilla.latencyMs.toFixed(0)} ms</p>
          <p>Round-trips: {result.vanilla.roundTrips}</p>
          <p>Tokens: {result.vanilla.tokensTransferred}</p>
        </div>
        <div>
          <p className="text-emerald-400">WhiteNoise</p>
          <p>Latency: {result.whitenoise.latencyMs.toFixed(0)} ms</p>
          <p>Round-trips: {result.whitenoise.roundTrips}</p>
          <p>Tokens: {result.whitenoise.tokensTransferred}</p>
        </div>
      </div>
    </div>
  );
}
