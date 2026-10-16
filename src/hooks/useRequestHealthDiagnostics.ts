import { useCallback, useEffect, useRef, useState } from "react";
import { proxyApi } from "@/lib/api/proxy";
import type { RequestHealthConfig, RequestHealthSnapshot } from "@/types/proxy";

interface UseRequestHealthDiagnosticsResult {
  snapshot?: RequestHealthSnapshot;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  acceptSavedConfig: (config: RequestHealthConfig) => void;
}

/**
 * Owns the shared Request Health diagnostics lifecycle used by settings and
 * the Codex status view. Configuration remains in RequestHealthPanel; this
 * hook only handles the backend snapshot and refresh state.
 */
export function useRequestHealthDiagnostics(
  enabled: boolean,
): UseRequestHealthDiagnosticsResult {
  const [snapshot, setSnapshot] = useState<RequestHealthSnapshot>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshSequence.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const sequence = ++refreshSequence.current;
    setIsRefreshing(true);
    setError(null);
    try {
      const next = await proxyApi.getRequestHealthDiagnostics();
      if (mounted.current && sequence === refreshSequence.current) {
        setSnapshot(next);
      }
    } catch (error) {
      if (mounted.current && sequence === refreshSequence.current) {
        setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (mounted.current && sequence === refreshSequence.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  const acceptSavedConfig = useCallback((config: RequestHealthConfig) => {
    if (!mounted.current) return;
    // A snapshot fetched before a save cannot replace its acknowledged config.
    refreshSequence.current += 1;
    setIsRefreshing(false);
    setSnapshot((current) =>
      current ? { ...current, config } : { config, diagnostics: [] },
    );
  }, []);

  useEffect(() => {
    if (enabled) {
      void refresh();
    } else {
      refreshSequence.current += 1;
      setIsRefreshing(false);
    }
  }, [enabled, refresh]);

  return { snapshot, isRefreshing, error, refresh, acceptSavedConfig };
}
