import { useState } from 'react';
import { useLLMRunner } from '../hooks/useLLMRunner';
import { ResultCard } from './ResultCard';

const PRESET_TASKS = [
  {
    id: 'echo-add',
    label: 'Echo "hello" then add 1 and 2, reply with the sum',
    task: 'Use the echo tool to echo the message "hello". Then use the add tool to add 1 and 2. Reply with the sum.',
  },
  {
    id: 'multi-echo',
    label: 'Echo three messages and summarize',
    task: 'Call the echo tool three times with messages "one", "two", and "three". Then reply with a single sentence summarizing what you did.',
  },
  {
    id: 'search-and-run',
    label: 'Search for a tool then run it (WhiteNoise-style)',
    task: 'First search for tools related to "echo". Then run the echo tool with message "found it". Reply with the result.',
  },
];

export function LLMComparison() {
  const [task, setTask] = useState(PRESET_TASKS[0]?.task ?? '');
  const {
    vanillaResult,
    whitenoiseResult,
    vanillaLoading,
    whitenoiseLoading,
    error,
    runVanilla,
    runWhiteNoise,
    runBoth,
  } = useLLMRunner(task);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
      <h2 className="mb-2 text-lg font-semibold">Two agents: Vanilla MCP vs WhiteNoise</h2>
      <p className="mb-4 text-sm text-zinc-400">
        Same task with real Gemini calls via <strong>LangChain-JS (LangGraph)</strong>: <strong>Vanilla MCP</strong> agent (all downstream tools in context) vs <strong>WhiteNoise</strong> agent (4 meta-tools). Set <code className="rounded bg-zinc-800 px-1">GEMINI_API_KEY</code> in the server env. Optional: <code className="rounded bg-zinc-800 px-1">LANGSMITH_TRACING</code> and <code className="rounded bg-zinc-800 px-1">LANGSMITH_API_KEY</code> for cost tracking.
      </p>

      <div className="mb-4">
        <label className="mb-2 block text-sm font-medium text-zinc-400">Preset</label>
        <select
          className="mb-2 w-full max-w-md rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
          value={PRESET_TASKS.find((p) => p.task === task)?.id ?? ''}
          onChange={(e) => {
            const p = PRESET_TASKS.find((x) => x.id === e.target.value);
            setTask(p ? p.task : task);
          }}
        >
          <option value="">Custom</option>
          {PRESET_TASKS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4">
        <label className="mb-2 block text-sm font-medium text-zinc-400">Task (user message to the LLM)</label>
        <textarea
          className="w-full max-w-2xl rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500"
          rows={3}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="e.g. Use echo to say hello, then add 1 and 2 and reply with the sum."
        />
      </div>

      <div className="mb-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={runVanilla}
          disabled={vanillaLoading || !task.trim()}
          className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-600 disabled:opacity-50"
        >
          {vanillaLoading ? 'Running…' : 'Run with Vanilla MCP'}
        </button>
        <button
          type="button"
          onClick={runWhiteNoise}
          disabled={whitenoiseLoading || !task.trim()}
          className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-600 disabled:opacity-50"
        >
          {whitenoiseLoading ? 'Running…' : 'Run with WhiteNoise'}
        </button>
        <button
          type="button"
          onClick={runBoth}
          disabled={(vanillaLoading || whitenoiseLoading) || !task.trim()}
          className="rounded bg-zinc-600 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-500 disabled:opacity-50"
        >
          Run both
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded bg-red-900/30 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ResultCard title="Vanilla MCP" result={vanillaResult} accent="red" />
        <ResultCard title="WhiteNoise" result={whitenoiseResult} accent="emerald" />
      </div>

      {vanillaResult && whitenoiseResult && (
        <div className="mt-6 rounded border border-zinc-700 bg-zinc-800/50 p-4">
          <h3 className="mb-2 text-sm font-medium text-zinc-300">Comparison</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-zinc-500">Latency: </span>
              <span className={vanillaResult.latencyMs <= whitenoiseResult.latencyMs ? 'text-zinc-300' : 'text-emerald-400'}>
                Vanilla {vanillaResult.latencyMs}ms vs WhiteNoise {whitenoiseResult.latencyMs}ms
              </span>
            </div>
            <div>
              <span className="text-zinc-500">Round-trips: </span>
              <span className={vanillaResult.roundTrips <= whitenoiseResult.roundTrips ? 'text-zinc-300' : 'text-emerald-400'}>
                Vanilla {vanillaResult.roundTrips} vs WhiteNoise {whitenoiseResult.roundTrips}
              </span>
            </div>
            <div>
              <span className="text-zinc-500">Prompt tokens: </span>
              <span className={vanillaResult.promptTokens <= whitenoiseResult.promptTokens ? 'text-emerald-400' : 'text-zinc-300'}>
                Vanilla {vanillaResult.promptTokens} vs WhiteNoise {whitenoiseResult.promptTokens}
              </span>
            </div>
            <div>
              <span className="text-zinc-500">Completion tokens: </span>
              <span className="text-zinc-300">
                Vanilla {vanillaResult.completionTokens} vs WhiteNoise {whitenoiseResult.completionTokens}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
