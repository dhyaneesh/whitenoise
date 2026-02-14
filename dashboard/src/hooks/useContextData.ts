import { useEffect, useState } from 'react';
import { fetchContext } from '../api';
import type { ContextComparison } from '../types';

/**
 * Shared hook for fetching context comparison data.
 * Avoids duplicate fetchContext() calls across components.
 */
export function useContextData() {
  const [context, setContext] = useState<ContextComparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchContext()
      .then(setContext)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return { context, error };
}
