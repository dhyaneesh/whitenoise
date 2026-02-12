import { useState } from 'react';
import { Layout } from './components/Layout';
import { LLMComparison } from './components/LLMComparison';
import { HeroMetrics } from './components/HeroMetrics';
import { LatencyChart } from './components/LatencyChart';
import { ContextComparison } from './components/ContextComparison';
import { RoundTripDiagram } from './components/RoundTripDiagram';
import { BenchmarkRunner } from './components/BenchmarkRunner';
import type { RunAllResultItem } from './types';

function App() {
  const [benchmarkResults, setBenchmarkResults] = useState<RunAllResultItem[] | null>(null);

  return (
    <Layout>
      <section>
        <LLMComparison />
      </section>
      <section className="mt-10">
        <HeroMetrics benchmarkResults={benchmarkResults} />
      </section>
      <section className="mt-10">
        <BenchmarkRunner onRunAllComplete={setBenchmarkResults} />
      </section>
      <section className="mt-10">
        <LatencyChart results={benchmarkResults} />
      </section>
      <section className="mt-10">
        <ContextComparison />
      </section>
      <section className="mt-10">
        <RoundTripDiagram />
      </section>
    </Layout>
  );
}

export default App;
