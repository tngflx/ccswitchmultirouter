import { useEffect, useRef } from "react";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
let invalidationEpoch = 0;

export const AUTO_MODEL_CACHE_TTL_MS = 15 * 60 * 1000;

export function modelRefreshCredentialFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cachedValue<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function invalidateAutoModelRefresh(key?: string): void {
  invalidationEpoch += 1;
  if (key) {
    cache.delete(key);
    inFlight.delete(key);
    return;
  }
  cache.clear();
  inFlight.clear();
}

export function useAutoModelRefresh<T>({
  cacheKey,
  enabled,
  fetcher,
  onSuccess,
  compareIds,
  onDiff,
  ttlMs = AUTO_MODEL_CACHE_TTL_MS,
}: {
  cacheKey: string;
  enabled: boolean;
  fetcher: () => Promise<T>;
  onSuccess: (value: T) => void;
  compareIds?: string[];
  onDiff?: (added: string[], removed: string[]) => void;
  ttlMs?: number;
}): void {
  const onSuccessRef = useRef(onSuccess);
  const fetcherRef = useRef(fetcher);
  onSuccessRef.current = onSuccess;
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled || !cacheKey) return;

    const cached = cachedValue<T>(cacheKey);
    if (cached !== undefined) {
      onSuccessRef.current(cached);
      return;
    }

    let cancelled = false;
    const requestEpoch = invalidationEpoch;
    const existing = inFlight.get(cacheKey) as Promise<T> | undefined;
    const request =
      existing ??
      fetcherRef.current().then((value) => {
        if (requestEpoch === invalidationEpoch) {
          cache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
        }
        return value;
      });
    if (!existing) inFlight.set(cacheKey, request);

    request
      .then((value) => {
        if (!cancelled && requestEpoch === invalidationEpoch) {
          if (compareIds && onDiff) {
            const fetchedIds = (value as unknown as { id?: string }[])
              ?.map((m) => (m?.id ?? "").trim())
              ?.filter(Boolean) ?? [];
            const savedSet = new Set(compareIds.filter(Boolean));
            const fetchedSet = new Set(fetchedIds);
            const added = fetchedIds.filter((id) => !savedSet.has(id));
            const removed = compareIds.filter((id) => !fetchedSet.has(id));
            if (added.length || removed.length) {
              onDiff(added, removed);
            }
          }
          onSuccessRef.current(value);
        }
      })
      .catch(() => {
        // Automatic refresh is best-effort; retain the saved/manual state.
      })
      .finally(() => {
        if (inFlight.get(cacheKey) === request) inFlight.delete(cacheKey);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, enabled, ttlMs]);
}
