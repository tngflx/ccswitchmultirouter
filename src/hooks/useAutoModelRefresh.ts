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

function reportModelDiff<T>(
  value: T,
  onDiff:
    | ((added: string[], removed: string[], updated: string[]) => void)
    | undefined,
  snapshotKey?: string,
): void {
  const fetched = Array.isArray(value)
    ? (value as { id?: string }[]).filter(
        (model) => typeof model?.id === "string" && model.id.trim(),
      )
    : [];
  const fetchedIds = Array.from(
    new Set(fetched.map((model) => model.id!.trim())),
  );
  // An empty response is not evidence that every saved model was removed.
  if (fetchedIds.length === 0) return;
  let previous: { id?: string }[] | undefined;
  if (snapshotKey) {
    try {
      const raw = localStorage.getItem(`model-catalog:${snapshotKey}`);
      const parsed: unknown = raw ? JSON.parse(raw) : undefined;
      if (Array.isArray(parsed) && parsed.length > 0)
        previous = parsed.filter(
          (model): model is { id: string } =>
            model !== null &&
            typeof model === "object" &&
            typeof model.id === "string" &&
            Boolean(model.id.trim()),
        );
      rememberModelRefreshSnapshot(snapshotKey, fetched);
    } catch {
      // Storage is optional; the fetched list remains usable without it.
    }
  }
  if (!previous || !onDiff) return;
  // A saved catalog is user-curated, not a prior upstream observation.
  const previousIds = Array.from(
    new Set(previous.map((model) => model.id!.trim())),
  );
  const previousSet = new Set(previousIds);
  const fetchedSet = new Set(fetchedIds);
  const added = fetchedIds.filter((id) => !previousSet.has(id));
  const removed = previousIds.filter((id) => !fetchedSet.has(id));
  // Metadata is refreshed silently through onSuccess. Only membership changes
  // are actionable enough to interrupt the user with a modal.
  if (added.length || removed.length) onDiff(added, removed, []);
}

export function rememberModelRefreshSnapshot<T>(key: string, value: T): void {
  if (
    !Array.isArray(value) ||
    !value.some(
      (model) => typeof model?.id === "string" && Boolean(model.id.trim()),
    )
  )
    return;
  try {
    localStorage.setItem(`model-catalog:${key}`, JSON.stringify(value));
  } catch {
    // Storage is optional; the fetched list remains usable without it.
  }
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
  snapshotKey,
  onDiff,
  ttlMs = AUTO_MODEL_CACHE_TTL_MS,
}: {
  cacheKey: string;
  enabled: boolean;
  fetcher: () => Promise<T>;
  onSuccess: (value: T) => void;
  snapshotKey?: string;
  onDiff?: (added: string[], removed: string[], updated: string[]) => void;
  ttlMs?: number;
}): void {
  const onSuccessRef = useRef(onSuccess);
  const fetcherRef = useRef(fetcher);
  const onDiffRef = useRef(onDiff);
  onSuccessRef.current = onSuccess;
  fetcherRef.current = fetcher;
  onDiffRef.current = onDiff;

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
          reportModelDiff(value, onDiffRef.current, snapshotKey);
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
  }, [cacheKey, enabled, snapshotKey, ttlMs]);
}
