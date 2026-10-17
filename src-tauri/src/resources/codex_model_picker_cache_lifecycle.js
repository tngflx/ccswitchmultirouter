const prepareCodexModelReasoningQueryCachesForReinjection = () => {
  const rebind = [];
  if (!(state.reasoningQueryCaches instanceof Map)) return rebind;
  for (const [cache, entry] of state.reasoningQueryCaches) {
    // Legacy entries cannot restore their original observer methods. Their
    // closures already read shared payload state; retain them until reload.
    if (typeof entry?.dispose !== "function") continue;
    try {
      entry.dispose();
    } catch {
      continue;
    }
    state.reasoningQueryCaches.delete(cache);
    rebind.push(cache);
  }
  return rebind;
};
