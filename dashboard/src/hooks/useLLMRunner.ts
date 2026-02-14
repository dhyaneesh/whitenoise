import { useState, useCallback } from 'react';
import { runVanillaLLM, runWhiteNoiseLLM } from '../api';
import type { LLMRunResult } from '../types';

export function useLLMRunner(task: string) {
  const [vanillaLoading, setVanillaLoading] = useState(false);
  const [whitenoiseLoading, setWhitenoiseLoading] = useState(false);
  const [vanillaResult, setVanillaResult] = useState<LLMRunResult | null>(null);
  const [whitenoiseResult, setWhitenoiseResult] = useState<LLMRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runVanilla = useCallback(async () => {
    setError(null);
    setVanillaResult(null);
    setVanillaLoading(true);
    try {
      const result = await runVanillaLLM(task);
      setVanillaResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVanillaLoading(false);
    }
  }, [task]);

  const runWhiteNoise = useCallback(async () => {
    setError(null);
    setWhitenoiseResult(null);
    setWhitenoiseLoading(true);
    try {
      const result = await runWhiteNoiseLLM(task);
      setWhitenoiseResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWhitenoiseLoading(false);
    }
  }, [task]);

  const runBoth = useCallback(async () => {
    setError(null);
    setVanillaResult(null);
    setWhitenoiseResult(null);
    setVanillaLoading(true);
    setWhitenoiseLoading(true);
    try {
      const [v, w] = await Promise.all([runVanillaLLM(task), runWhiteNoiseLLM(task)]);
      setVanillaResult(v);
      setWhitenoiseResult(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVanillaLoading(false);
      setWhitenoiseLoading(false);
    }
  }, [task]);

  return {
    vanillaResult,
    whitenoiseResult,
    vanillaLoading,
    whitenoiseLoading,
    error,
    runVanilla,
    runWhiteNoise,
    runBoth,
  };
}
