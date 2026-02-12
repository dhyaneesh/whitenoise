import { useEffect, useState } from 'react';
import { fetchContext } from '../api';
import type { ContextComparison as ContextType } from '../types';

export function ContextComparison() {
  const [context, setContext] = useState<ContextType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchContext()
      .then(setContext)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (!context) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
        <p className="text-zinc-500">Loading context comparison…</p>
      </div>
    );
  }

  const reduction =
    context.vanilla.schemaTokens > 0
      ? Math.round(
          (1 - context.whitenoise.schemaTokens / context.vanilla.schemaTokens) *
            100
        )
      : 0;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
      <h2 className="mb-4 text-lg font-semibold">Context window size</h2>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-red-400">
            <span className="h-3 w-3 rounded-full bg-red-500" />
            Vanilla MCP
          </h3>
          <p className="text-sm text-zinc-400">
            {context.vanilla.toolCount} tools · ~{context.vanilla.schemaTokens}{' '}
            tokens in context
          </p>
          <pre className="mt-3 max-h-48 overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-400">
            {context.vanilla.schemaJson.slice(0, 1200)}
            {context.vanilla.schemaJson.length > 1200 ? '…' : ''}
          </pre>
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-400">
            <span className="h-3 w-3 rounded-full bg-emerald-500" />
            WhiteNoise
          </h3>
          <p className="text-sm text-zinc-400">
            {context.whitenoise.toolCount} meta-tools · ~
            {context.whitenoise.schemaTokens} tokens in context
          </p>
          <pre className="mt-3 max-h-48 overflow-auto rounded bg-zinc-950 p-3 text-xs text-zinc-400">
            {context.whitenoise.schemaJson}
          </pre>
        </div>
      </div>
      <p className="mt-4 text-center text-emerald-400">
        ~{reduction}% fewer context tokens with WhiteNoise
      </p>
    </div>
  );
}
