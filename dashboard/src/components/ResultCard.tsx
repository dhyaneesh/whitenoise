import { memo } from 'react';
import type { LLMRunResult } from '../types';

type ResultCardProps = {
  title: string;
  result: LLMRunResult | null;
  accent: 'red' | 'emerald';
};

export const ResultCard = memo(function ResultCard({
  title,
  result,
  accent,
}: ResultCardProps) {
  if (!result) {
    return (
      <div className="rounded border border-zinc-700 bg-zinc-800/30 p-4">
        <h3 className={`text-sm font-medium ${accent === 'red' ? 'text-red-400' : 'text-emerald-400'}`}>{title}</h3>
        <p className="mt-2 text-sm text-zinc-500">No result yet. Run the task above.</p>
      </div>
    );
  }

  const borderClass = accent === 'red' ? 'border-red-900/50' : 'border-emerald-900/50';

  return (
    <div className={`rounded border ${borderClass} bg-zinc-800/30 p-4`}>
      <h3 className={`text-sm font-medium ${accent === 'red' ? 'text-red-400' : 'text-emerald-400'}`}>{title}</h3>
      {result.error && (
        <p className="mt-2 text-sm text-red-400">{result.error}</p>
      )}
      <dl className="mt-2 space-y-1 text-sm">
        <div>
          <span className="text-zinc-500">Latency: </span>
          <span className="text-zinc-300">{result.latencyMs} ms</span>
        </div>
        <div>
          <span className="text-zinc-500">Round-trips: </span>
          <span className="text-zinc-300">{result.roundTrips}</span>
        </div>
        <div>
          <span className="text-zinc-500">Tokens: </span>
          <span className="text-zinc-300">{result.promptTokens} prompt + {result.completionTokens} completion</span>
        </div>
        <div>
          <span className="text-zinc-500">Messages: </span>
          <span className="text-zinc-300">{result.messageCount}</span>
        </div>
      </dl>
      {result.finalMessage && (
        <div className="mt-3 rounded bg-zinc-950 p-3">
          <p className="text-xs text-zinc-500">Final reply</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-300">{result.finalMessage}</p>
        </div>
      )}
    </div>
  );
});
