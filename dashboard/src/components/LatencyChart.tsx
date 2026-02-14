import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { RunAllResultItem } from '../types';

type LatencyChartProps = {
  results: RunAllResultItem[] | null;
};

const scenarioNames: Record<string, string> = {
  single: 'Single tool',
  'chain-2': '2-tool chain',
  'chain-3': '3-tool chain',
  'chain-5': '5-tool chain',
};

const tooltipContentStyle = {
  backgroundColor: '#27272a',
  border: '1px solid #3f3f46',
  borderRadius: '8px',
};

const tooltipLabelStyle = { color: '#d4d4d8' };

export function LatencyChart({ results }: LatencyChartProps) {
  const data = useMemo(
    () =>
      results?.map((r) => ({
        name: scenarioNames[r.scenarioId] ?? r.scenarioId,
        scenarioId: r.scenarioId,
        Vanilla: Math.round(r.vanilla.latencyMs),
        WhiteNoise: Math.round(r.whitenoise.latencyMs),
      })) ?? [],
    [results]
  );

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
      <h2 className="mb-4 text-lg font-semibold">Latency comparison (ms)</h2>
      {data.length === 0 ? (
        <p className="py-8 text-center text-zinc-500">
          Run &quot;Run all benchmarks&quot; to see the chart.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
            <XAxis dataKey="name" stroke="#a1a1aa" fontSize={12} />
            <YAxis stroke="#a1a1aa" fontSize={12} />
            <Tooltip
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
            />
            <Legend />
            <Bar dataKey="Vanilla" fill="#ef4444" radius={[4, 4, 0, 0]} />
            <Bar dataKey="WhiteNoise" fill="#22c55e" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
