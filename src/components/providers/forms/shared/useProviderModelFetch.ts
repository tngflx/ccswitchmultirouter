import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";

interface ModelFetchState {
  identity: symbol;
  fetchedModels: FetchedModel[];
  isFetchingModels: boolean;
}

/**
 * Ordinary API-key model discovery shared by Gemini and OpenClaw forms.
 * OAuth, Token Exchange and provider-specific catalog reconciliation stay with
 * their owning forms instead of inheriting this path's credential requirements.
 */
export function useProviderModelFetch(
  baseUrl: string,
  apiKey: string,
  t: TFunction,
) {
  // Opaque ownership avoids storing or serializing credentials in a cache key.
  // A -> B -> A is a new identity, not permission to revive A's old directory.
  const identity = useMemo(
    () => Symbol("provider-model-fetch"),
    [baseUrl, apiKey],
  );
  const ownership = useRef({ identity, sequence: 0, mounted: false });
  const [state, setState] = useState<ModelFetchState>(() => ({
    identity,
    fetchedModels: [],
    isFetchingModels: false,
  }));

  useLayoutEffect(() => {
    ownership.current.identity = identity;
    ownership.current.mounted = true;
    setState((previous) =>
      !ownership.current.mounted ||
      ownership.current.identity !== identity ||
      previous.identity === identity
        ? previous
        : { identity, fetchedModels: [], isFetchingModels: false },
    );
    return () => {
      // Commit/unmount ownership changes must precede queued promise handlers;
      // an abandoned render must not invalidate the still-mounted owner.
      ownership.current.mounted = false;
      ownership.current.sequence += 1;
    };
  }, [identity]);

  const handleFetchModels = useCallback(() => {
    const owner = ownership.current;
    if (!owner.mounted || owner.identity !== identity) return;
    // Invalidate every older attempt before preflight or starting a new one.
    const sequence = ++owner.sequence;
    const isCurrent = () =>
      ownership.current.mounted &&
      ownership.current.identity === identity &&
      ownership.current.sequence === sequence;
    if (!baseUrl || !apiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!apiKey,
        hasBaseUrl: !!baseUrl,
      });
      return;
    }
    setState((previous) =>
      isCurrent()
        ? {
            identity,
            fetchedModels:
              previous.identity === identity ? previous.fetchedModels : [],
            isFetchingModels: true,
          }
        : previous,
    );
    fetchModelsForConfig(baseUrl, apiKey)
      .then((models) => {
        if (!isCurrent()) return;
        setState((previous) =>
          isCurrent()
            ? { identity, fetchedModels: models, isFetchingModels: true }
            : previous,
        );
        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        } else {
          toast.success(
            t("providerForm.fetchModelsSuccess", { count: models.length }),
          );
        }
      })
      .catch((err) => {
        if (!isCurrent()) return;
        // Arbitrary discovery errors can contain URLs or credentials. The
        // shared UX helper classifies them without displaying their raw text.
        console.warn("[ModelFetch] Failed");
        showFetchModelsError(err, t);
      })
      .finally(() => {
        if (!isCurrent()) return;
        setState((previous) =>
          isCurrent() ? { ...previous, isFetchingModels: false } : previous,
        );
      });
  }, [baseUrl, apiKey, identity, t]);

  // Never expose the previous owner's data, including the render before the
  // identity-change layout effect clears its stored state.
  return {
    fetchedModels: state.identity === identity ? state.fetchedModels : [],
    isFetchingModels: state.identity === identity && state.isFetchingModels,
    handleFetchModels,
  };
}
