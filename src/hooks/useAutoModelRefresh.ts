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
  compareIds: string[] | undefined,
  onDiff:
    | ((added: string[], removed: string[], updated: string[]) => void)
    | undefined,
  snapshotKey?: string,
  reportInitialAdditions = false,
): void {
  if (!onDiff) return;
  const fetched = Array.isArray(value)
    ? (value as { id?: string }[]).filter(
        (model) => typeof model?.id === "string" && model.id.trim(),
      )
    : [];
  const fetchedIds = fetched.map((model) => model.id!.trim());
  // An empty response is not evidence that every saved model was removed.
  if (fetchedIds.length === 0) return;
  let previous: { id?: string }[] | undefined;
  if (snapshotKey) {
    try {
      const raw = localStorage.getItem(`model-catalog:${snapshotKey}`);
      const parsed: unknown = raw ? JSON.parse(raw) : undefined;
      if (Array.isArray(parsed))
        previous = parsed.filter(
          (model): model is { id: string } =>
            model !== null &&
            typeof model === "object" &&
            typeof model.id === "string" &&
            Boolean(model.id.trim()),
        );
      localStorage.setItem(
        `model-catalog:${snapshotKey}`,
        JSON.stringify(fetched),
      );
    } catch {
      // Storage is optional; the fetched list remains usable without it.
    }
  }
  if (!previous && !compareIds) return;
  // `compareIds` is the saved catalog and is the ONLY baseline for additions
  // and removals. The localStorage snapshot records the last *fetched* payload
  // purely so metadata edits can be reported as "updated".
  //
  // The snapshot must never contribute to `removed`. It is a record of what
  // upstream returned one poll ago, not of what the user saved, so folding it
  // in re-created the original bug: every model the provider trimmed upstream
  // was announced as "removed" although it had never been in the catalog.
  const savedIds = (compareIds ?? []).map((id) => id.trim()).filter(Boolean);
  const savedSet = new Set(savedIds);
  const fetchedSet = new Set(fetchedIds);
  const added =
    previous || reportInitialAdditions
      ? fetchedIds.filter((id) => !savedSet.has(id))
      : [];
  const removed = savedIds.filter((id) => !fetchedSet.has(id));
  const previousById = new Map(previous?.map((model) => [model.id, model]));
  const fetchedById = new Map(fetched.map((model) => [model.id, model]));
  const updated = previous
    ? fetchedIds.filter((id) => {
        const before = previousById.get(id);
        const after = fetchedById.get(id);
        return (
          before && after && JSON.stringify(before) !== JSON.stringify(after)
        );
      })
    : [];
  // A model cannot be both removed and updated in the same report. Removal
  // wins, because an absent model has no metadata left to update.
  const removedSet = new Set(removed);
  if (added.length || removed.length || updated.length)
    onDiff(
      added,
      removed,
      updated.filter((id) => !removedSet.has(id)),
    );
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
  snapshotKey,
  reportInitialAdditions = false,
  onDiff,
  ttlMs = AUTO_MODEL_CACHE_TTL_MS,
}: {
  cacheKey: string;
  enabled: boolean;
  fetcher: () => Promise<T>;
  onSuccess: (value: T) => void;
  compareIds?: string[];
  snapshotKey?: string;
  reportInitialAdditions?: boolean;
  onDiff?: (added: string[], removed: string[], updated: string[]) => void;
  ttlMs?: number;
}): void {
  const onSuccessRef = useRef(onSuccess);
  const fetcherRef = useRef(fetcher);
  const onDiffRef = useRef(onDiff);
  const compareIdsRef = useRef(compareIds);
  onSuccessRef.current = onSuccess;
  fetcherRef.current = fetcher;
  onDiffRef.current = onDiff;
  compareIdsRef.current = compareIds;

  useEffect(() => {
    if (!enabled || !cacheKey) return;

    const cached = cachedValue<T>(cacheKey);
    if (cached !== undefined) {
      if (!snapshotKey)
        reportModelDiff(
          cached,
          compareIdsRef.current,
          onDiffRef.current,
          undefined,
          reportInitialAdditions,
        );
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
          reportModelDiff(
            value,
            compareIdsRef.current,
            onDiffRef.current,
            snapshotKey,
            reportInitialAdditions,
          );
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
  }, [cacheKey, enabled, reportInitialAdditions, snapshotKey, ttlMs]);
}
