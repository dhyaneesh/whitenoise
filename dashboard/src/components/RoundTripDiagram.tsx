export function RoundTripDiagram() {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
      <h2 className="mb-4 text-lg font-semibold">Round-trips: Vanilla vs WhiteNoise</h2>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-sm font-medium text-red-400">Vanilla MCP (e.g. 3-tool chain)</h3>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded bg-zinc-800 px-2 py-1">LLM</span>
            <span className="text-zinc-500">&rarr;</span>
            <span className="rounded bg-zinc-800 px-2 py-1">Tool 1</span>
            <span className="text-zinc-500">&rarr;</span>
            <span className="rounded bg-zinc-800 px-2 py-1">LLM</span>
            <span className="text-zinc-500">&rarr;</span>
            <span className="rounded bg-zinc-800 px-2 py-1">Tool 2</span>
            <span className="text-zinc-500">&rarr;</span>
            <span className="rounded bg-zinc-800 px-2 py-1">LLM</span>
            <span className="text-zinc-500">&rarr;</span>
            <span className="rounded bg-zinc-800 px-2 py-1">Tool 3</span>
          </div>
          <p className="mt-2 text-xs text-zinc-500">3 round-trips · each result back through the model</p>
          <div className="mt-3 flex items-center gap-1">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-diagram-pulse h-2 flex-1 rounded bg-red-500/30"
                style={{ animationDelay: `${i * 0.2}s` }}
              />
            ))}
          </div>
        </div>
        <div>
          <h3 className="mb-3 text-sm font-medium text-emerald-400">WhiteNoise (same 3-tool chain)</h3>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded bg-zinc-800 px-2 py-1">LLM</span>
            <span className="text-zinc-500">&rarr;</span>
            <span className="rounded bg-emerald-900/50 px-2 py-1 text-emerald-300">execute_code</span>
            <span className="text-zinc-500">&rarr;</span>
            <span className="rounded bg-zinc-800 px-2 py-1">Tool 1 &rarr; 2 &rarr; 3</span>
          </div>
          <p className="mt-2 text-xs text-zinc-500">1 round-trip · chaining inside worker</p>
          <div className="mt-3 flex items-center gap-1">
            <div className="animate-diagram-pulse h-2 flex-1 rounded bg-emerald-500/50" />
          </div>
        </div>
      </div>
    </div>
  );
}
