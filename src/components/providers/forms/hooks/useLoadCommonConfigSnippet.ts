import { useEffect } from "react";
import { configApi } from "@/lib/api";

/** Load persisted snippets; retire legacy storage only after a successful save. */
export function useLoadCommonConfigSnippet(
  app: "claude" | "codex" | "gemini",
  legacyKey: string,
  setSnippet: (snippet: string) => void,
  setLoading: (loading: boolean) => void,
  enabled = true,
  validateLegacy?: (snippet: string) => { error?: string },
) {
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    const load = async () => {
      try {
        let snippet = await configApi.getCommonConfigSnippet(app);
        if (!snippet?.trim() && typeof window !== "undefined") {
          const legacy = window.localStorage.getItem(legacyKey);
          if (legacy?.trim() && !validateLegacy?.(legacy).error) {
            await configApi.setCommonConfigSnippet(app, legacy);
            window.localStorage.removeItem(legacyKey);
            snippet = legacy;
          }
        }
        if (mounted && snippet?.trim()) setSnippet(snippet);
      } catch (error) {
        console.error(`Failed to load ${app} common config`, error);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [app, legacyKey, setSnippet, setLoading, enabled, validateLegacy]);
}
