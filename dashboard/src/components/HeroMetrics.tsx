import { useEffect, useState } from 'react';
import { fetchContext } from '../api';
import type { ContextComparison } from '../types';
import type { RunAllResultItem } from '../types';

type HeroMetricsProps = {
  benchmarkResults?: RunAllResultItem[] | null;
};

export function HeroMetrics({ benchmarkResults }: HeroMetricsProps) {
  const [context, setContext] = useState<ContextComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchContext()
      .then(setContext)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const contextReduction =
    context && context.vanilla.schemaTokens > 0
      ? Math.round(
          (1 - context.whitenoise.schemaTokens / context.vanilla.schemaTokens) * 100
        )
      : null;

  const chain3 = benchmarkResults?.find((r) => r.scenarioId === 'chain-3');
  const latencyReduction =
    chain3 && chain3.vanilla.latencyMs > 0
      ? Math.round(
          (1 - chain3.whitenoise.latencyMs / chain3.vanilla.latencyMs) * 100
        )
      : null;

  const roundTripVanilla = chain3?.vanilla.roundTrips ?? 0;
  const roundTripWhiteNoise = chain3?.whitenoise.roundTrips ?? 1;

  const tokenReduction =
    chain3 && chain3.vanilla.tokensTransferred > 0
      ? Math.round(
          (1 -
            chain3.whitenoise.tokensTransferred /
              chain3.vanilla.tokensTransferred) *
            100
        )
      : null;

  const cards = [
    {
      label: 'Context tokens (upfront)',
      value: contextReduction != null ? `${contextReduction}% fewer` : '—',
      sub: context
        ? `WhiteNoise: ${context.whitenoise.schemaTokens} vs Vanilla: ${context.vanilla.schemaTokens}`
        : 'Run context load',
      accent: 'text-emerald-400',
    },
    {
      label: 'Latency (3-tool chain)',
      value:
        latencyReduction != null ? `${latencyReduction}% less` : '—',
      sub: chain3
        ? `${chain3.whitenoise.latencyMs.toFixed(0)}ms vs ${chain3.vanilla.latencyMs.toFixed(0)}ms`
        : 'Run benchmark',
      accent: 'text-sky-400',
    },
    {
      label: 'Round-trips',
      value: `${roundTripWhiteNoise} vs ${roundTripVanilla}`,
      sub: 'WhiteNoise vs Vanilla (3-tool)',
      accent: 'text-amber-400',
    },
    {
      label: 'Tokens transferred',
      value: tokenReduction != null ? `${tokenReduction}% fewer` : '—',
      sub: chain3
        ? `WhiteNoise: ${chain3.whitenoise.tokensTransferred} vs Vanilla: ${chain3.vanilla.tokensTransferred}`
        : 'Run benchmark',
      accent: 'text-violet-400',
    },
  ];

  return (
    <section>
      {error && (
        <p className="mb-4 rounded bg-red-900/30 px-4 py-2 text-red-300">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5"
          >
            <p className="text-sm font-medium text-zinc-400">{card.label}</p>
            <p className={`mt-2 text-2xl font-semibold ${card.accent}`}>
              {card.value}
            </p>
            <p className="mt-1 text-xs text-zinc-500">{card.sub}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
