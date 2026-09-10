import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchModelsDevPricing, flattenModels } from "@/lib/modelsDevPricing";

export function useModelsDevCatalog(
  search: string,
  providerFilter: string,
  defaultRows: number,
  maxRows: number,
  enabled = true,
) {
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["models-dev-pricing"],
    queryFn: fetchModelsDevPricing,
    enabled,
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  const entries = useMemo(() => (data ? flattenModels(data) : []), [data]);

  const providers = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (!map.has(entry.providerId)) {
        map.set(entry.providerId, entry.providerName);
      }
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [entries]);

  const isFiltering = search.trim() !== "" || providerFilter !== "all";

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        (providerFilter === "all" || entry.providerId === providerFilter) &&
        (!query ||
          entry.modelId.toLowerCase().includes(query) ||
          entry.normalizedId.includes(query) ||
          entry.modelName.toLowerCase().includes(query) ||
          entry.providerName.toLowerCase().includes(query)),
    );
  }, [entries, search, providerFilter]);

  // Keep rendering bounded while filtering the complete catalog.
  const visible = useMemo(
    () => filtered.slice(0, isFiltering ? maxRows : defaultRows),
    [filtered, isFiltering, maxRows, defaultRows],
  );

  return {
    data,
    entries,
    providers,
    filtered,
    visible,
    isFiltering,
    isLoading,
    isFetching,
    error,
    refetch,
  };
}
