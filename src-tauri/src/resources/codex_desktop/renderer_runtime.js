(async () => {
  const incomingPayload = __CCSWITCH_CATALOG_PAYLOAD__;
  if (__CCSWITCH_CATALOG_RELEASED__) incomingPayload.catalogReleased = true;
  const patchKey = __CCSWITCH_PATCH_KEY__;
  const state = window[patchKey] || {};
  // Canonical status tokens are only candidates across runtime replacement;
  // the new code resolves their current mounted scope before rebinding.
  const previousAppServerStatusAtoms = state.appServerStatusAtoms || [];
  const previousAppServerStatusBindings = state.appServerStatusBindings || [];
  // DOM controls and event closures belong to this exact installation.
  state.nativeBooleanReasoningRestore?.();
  /*__CCSWITCH_CATALOG_PAYLOAD_SELECTION_CORE__*/
  const previousPayload = state.payload;
  /*__CCSWITCH_MODEL_PICKER_RELEASE_CORE__*/
  if (incomingPayload?.catalogReleased === true)
    releaseCodexModelPicker(incomingPayload.modelProvider);
  else cancelCodexModelPickerReleaseRefresh();
  const payload = selectCatalogPayload(state.payload, incomingPayload);
  const preservePreviousCatalog =
    payload !== incomingPayload && payload?.catalogAvailable === true;
  const installationGeneration = (state.runtimeGeneration || 0) + 1;
  state.runtimeGeneration = installationGeneration;
  // Continuation commit closures capture installationIsCurrent. Any new
  // injection (including same-fingerprint reinjection) invalidates those
  // closures, so never let a prepared job survive into a newer generation.
  state.codexContinuationJobs = {};
  const installationIsCurrent = () =>
    state.runtimeGeneration === installationGeneration;
  state.runPromise = null;
  // Numeric discovery belongs to this installation generation too. A pending
  // import from a previous (even same-fingerprint) injection cannot own or
  // clear the replacement job after it eventually settles.
  state.webpackPickerDiscoveryPromise = null;
  state.webpackPickerDiscoveryRetryAt = 0;
  state.reactDiscoveryPromise = null;
  state.scopedAppServerDiscoveryPromise = null;
  // Root-observer callbacks capture this installation generation too. Rebind
  // even for an unchanged fingerprint; retaining the old observer would leave
  // a truthy but permanently inert callback after installationIsCurrent fails.
  try {
    const pendingMutations = state.reactRootObserver?.takeRecords?.();
    if (pendingMutations?.length) {
      state.reactMutationGeneration = (state.reactMutationGeneration || 0) + 1;
      state.scopedAppServerScopeScanComplete = false;
    }
  } catch {
    state.scopedAppServerScopeScanComplete = false;
  }
  try {
    state.reactRootObserver?.disconnect();
  } catch {}
  state.reactRootObserver = null;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
  state.catalogReleased = incomingPayload?.catalogReleased === true;
  if (
    previousPayload?.catalogAvailable === true &&
    !state.modelPickerStatsigOverrides
  )
    state.modelPickerLegacyStatsigBaselineUnavailable = true;
  // This is a content fingerprint of the embedded renderer resources. The
  // runtime closure captures those functions; a changed fingerprint tears
  // down an older interval and rebinds every owned hook automatically.
  const rendererRuntimeFingerprint = __CCSWITCH_RENDERER_RUNTIME_FINGERPRINT__;
  let reasoningQueryCachesToRebind = [];
  /*__CCSWITCH_QUERY_CACHE_LIFECYCLE_CORE__*/
  const cleanupMessagePatch = () => {
    try {
      if (typeof state.messagePatchListener === "function")
        window.removeEventListener("message", state.messagePatchListener, true);
    } catch {}
    try {
      if (
        state.messagePatchPatchedDispatchEvent &&
        window.dispatchEvent === state.messagePatchPatchedDispatchEvent &&
        typeof state.messagePatchOriginalDispatchEvent === "function"
      )
        window.dispatchEvent = state.messagePatchOriginalDispatchEvent;
    } catch {}
    state.messagePatchListener = null;
    state.messagePatchPatchedDispatchEvent = null;
    state.messagePatchOriginalDispatchEvent = null;
    state.messagePatchInstalled = false;
  };
  if (
    state.rendererRuntimeFingerprint !== rendererRuntimeFingerprint ||
    previousPayload?.catalogReleased === true
  ) {
    state.nativeReasoningVisibilityRestore?.();
    if (state.interval) clearInterval(state.interval);
    try {
      state.reactRootObserver?.disconnect();
    } catch {}
    cleanupMessagePatch();
    reasoningQueryCachesToRebind =
      prepareCodexModelReasoningQueryCachesForReinjection();
    state.interval = null;
    state.reactRootObserver = null;
    // Older discovery admitted dynamic RPC stubs before patching failed. Drop
    // that registry so continuation can use only declared request clients.
    state.appServerClients = [];
    state.scopedAppServerClientSet = new Set();
    state.scopedAppServerClientOwners = new Map();
    state.scopedAppServerRpcClientOwners = new Map();
    state.moduleAppServerClientOwners = new Map();
    state.reactAppServerClientOwners = new Map();
    state.requestIds = new Map();
    state.modelListRequestScopes = new Map();
    state.appServerModuleRetryAt = 0;
    state.nativeReasoningScopeRetryAt = 0;
    state.webpackPickerNamespaces = new Map();
    // Semantic module URLs can resolve to different renderer chunks after a
    // reinjection/navigation. Drop in-flight and fulfilled discovery promises
    // so the new fingerprint cannot reuse a stale module namespace or scope.
    state.modulePromises = new Map();
    state.scopedAppServerScopes = new Set();
    state.scopedAppServerScopeCandidates = new Set();
    state.scopedAppServerRegistryClasses = [];
    state.appServerStatusAtoms = [];
    state.appServerStatusBindings = [];
    state.scopedAppServerRegistryInstances = new Set();
    state.scopedAppServerScopesScannedAt = null;
    state.scopedAppServerScopeScanComplete = false;
    state.scopedAppServerRootIdentities = [];
    state.webpackPickerDiscovery = null;
    // Recompute native visibility from the current initialized webpack
    // inventory. A prior injection must not permanently require a projection
    // that the current renderer no longer exposes.
    state.nativeReasoningVisibilityRequired = false;
    state.nativeReasoningVisibilityAtoms = [];
    state.pendingReactNodes = new Set();
    state.reactMutationGeneration = 0;
    state.lastReactFullScanAt = 0;
    state.lastReactIncrementalScanAt = 0;
    state.reactInitialDiscoveryCompleted = false;
    state.rendererRuntimeFingerprint = rendererRuntimeFingerprint;
  }
  if (
    normalizedCatalogProvider(previousPayload?.modelProvider) !==
    normalizedCatalogProvider(payload?.modelProvider)
  ) {
    state.catalogProviderEpoch = (state.catalogProviderEpoch || 0) + 1;
  }
  state.payload = payload;
  state.catalogPayloadPreserved = preservePreviousCatalog;
  state.requestIds =
    state.requestIds instanceof Map ? state.requestIds : new Map();
  state.modelListRequestScopes = state.modelListRequestScopes || new Map();
  state.modulePromises = state.modulePromises || new Map();
  state.webpackPickerNamespaces = state.webpackPickerNamespaces || new Map();
  state.failures = state.failures || [];
  state.pendingReactNodes = state.pendingReactNodes || new Set();
  state.reactMutationGeneration = state.reactMutationGeneration || 0;
  state.historyManagerCandidates = state.historyManagerCandidates || new Set();
  const recordFailure = (error) => {
    const message = String(error?.message || error);
    if (state.failures.at(-1) !== message) state.failures.push(message);
    state.failures = state.failures.slice(-20);
  };
  window[patchKey] = state;
  /*__CCSWITCH_MODEL_PATCH_CORE__*/
  /*__CCSWITCH_NATIVE_BOOLEAN_REASONING_CORE__*/
  for (const cache of reasoningQueryCachesToRebind) {
    try {
      patchCodexModelReasoningQueryCache(cache);
    } catch (error) {
      recordFailure(error);
    }
  }
  /*__CCSWITCH_GUARDIAN_V2_PATCH_CORE__*/
  /*__CCSWITCH_REQUEST_NORMALIZATION_CORE__*/
  /*__CCSWITCH_HISTORY_LINEAGE_HYDRATION_CORE__*/
  /*__CCSWITCH_MODULE_CLIENT_DISCOVERY_CORE__*/
  // Status atoms were validated against initialized module exports. Preserve
  // only their read-only token identity; every use re-reads the current local
  // status/client and current mounted node before authorizing requests.
  state.appServerStatusAtoms = previousAppServerStatusAtoms;
  state.appServerStatusBindings = previousAppServerStatusBindings;
  // Bootstrap only canonical app-server brands. Retained picker scopes can
  // include thousands of orphan aliases; they belong to async inventory.
  const mountedPreviousScopes = previousAppServerStatusAtoms.length
    ? codexCurrentAppServerScopeHints()
    : [];
  // Canonical RPC brands are only a warm subset, never a replacement for
  // a complete current picker-owner inventory on same-fingerprint injection.
  // An old or incomplete snapshot must instead be proved by a fresh tree scan.
  if (!codexRendererScopeSnapshotIsCurrent()) {
    state.scopedAppServerScopeScanComplete = false;
    state.scopedAppServerScopeCandidates = new Set(mountedPreviousScopes);
  }
  state.scopedAppServerSeedRefreshPending = mountedPreviousScopes.length > 0;
  /*__CCSWITCH_WEBPACK_DISCOVERY_CORE__*/
  /*__CCSWITCH_NATIVE_REASONING_VISIBILITY_CORE__*/
  /*__CCSWITCH_MODEL_PICKER_DIAGNOSTICS_CORE__*/
  state.readCodexModelPickerDiagnostics = codexModelPickerDiagnostics;
  /*__CCSWITCH_REQUEST_HEALTH_WARNING_CORE__*/
  /*__CCSWITCH_SUMMARY_HANDOFF_CORE__*/
  /*__CCSWITCH_CODEX_CONTINUATION_CORE__*/
  /*__CCSWITCH_OWNER_REMOTE_VIEW_CORE__*/
  const patchStatsigConfig = (name, config, repairLegacyPollution = false) => {
    const prepared = prepareStatsigDynamicConfig(
      name,
      config,
      repairLegacyPollution,
    );
    config = prepared.config;
    if (!prepared.patchModelWhitelist) return config;
    // An unavailable/empty fallback catalog must never turn the native
    // Statsig whitelist into an empty list. A structurally valid canonical
    // empty catalog remains authoritative and is still filtered below.
    if (state.payload?.catalogAvailable !== true) return config;
    const value = config?.value;
    if (!value || typeof value !== "object") return config;
    state.modelPickerStatsigOverrides =
      state.modelPickerStatsigOverrides || new Map();
    let owned = state.modelPickerStatsigOverrides.get(config);
    if (!owned && !state.modelPickerLegacyStatsigBaselineUnavailable) {
      owned = { originalValue: value, projectedValue: null };
      state.modelPickerStatsigOverrides.set(config, owned);
    }
    const available = modelNames();
    const existingAvailable = Array.isArray(value.available_models)
      ? value.available_models
      : [];
    const changed =
      existingAvailable.length !== available.length ||
      existingAvailable.some((name, index) => name !== available[index]);
    const nextValue = {
      ...value,
      available_models: available,
      use_hidden_models: false,
      default_model: modelNames()[0] || value.default_model,
    };
    if (
      changed ||
      nextValue.default_model !== value.default_model ||
      value.use_hidden_models !== false
    ) {
      try {
        config.value = nextValue;
        if (owned) owned.projectedValue = nextValue;
      } catch {
        return { ...config, value: nextValue };
      }
    }
    return config;
  };
  const statsigClients = () => {
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [
      root.firstInstance,
      typeof root.instance === "function" ? root.instance() : null,
    ];
    if (root.instances && typeof root.instances === "object")
      clients.push(...Object.values(root.instances));
    return clients.filter(
      (client, index, array) =>
        client && typeof client === "object" && array.indexOf(client) === index,
    );
  };
  const patchStatsig = () => {
    for (const client of statsigClients()) {
      if (typeof client.getDynamicConfig !== "function") continue;
      if (client.__ccSwitchStatsigPatchVersion !== rendererRuntimeFingerprint) {
        const repairingLegacyPatch =
          client.__ccSwitchModelWhitelistPatched === true;
        const original =
          client.__ccSwitchOriginalGetDynamicConfig ||
          client.getDynamicConfig.bind(client);
        client.__ccSwitchOriginalGetDynamicConfig = original;
        const patched = (name, options) =>
          patchStatsigConfig(
            name,
            original(name, options),
            repairingLegacyPatch,
          );
        client.getDynamicConfig = patched;
        state.modelPickerStatsigGetters =
          state.modelPickerStatsigGetters || new Map();
        state.modelPickerStatsigGetters.set(client, { original, patched });
        client.__ccSwitchStatsigPatchVersion = rendererRuntimeFingerprint;
      }
      try {
        patchStatsigConfig(
          "107580212",
          client.getDynamicConfig("107580212", { disableExposureLog: true }),
        );
      } catch {}
      try {
        patchStatsigConfig(
          guardianV2DynamicConfigName,
          client.getDynamicConfig(guardianV2DynamicConfigName, {
            disableExposureLog: true,
          }),
        );
      } catch {}
    }
  };
  const sameOriginJavascriptAssetUrl = (raw) => {
    try {
      const base = new URL(
        document.baseURI || window.location?.href || globalThis.location?.href,
      );
      const url = new URL(raw, base);
      // Opaque custom-scheme origins are all "null": protocol and host must
      // match too. Performance/link entries are not import authorization for
      // foreign assets, even when they contain an expected semantic filename.
      if (
        (!base.host && base.protocol !== "file:") ||
        url.protocol !== base.protocol ||
        url.host !== base.host ||
        url.origin !== base.origin ||
        url.username ||
        url.password ||
        !url.pathname.includes("/assets/") ||
        !url.pathname.endsWith(".js")
      )
        return "";
      return url.href;
    } catch {
      return "";
    }
  };
  const visibleAssetUrls = () =>
    // Only executed script elements authorize the legacy semantic fallback.
    // Link-preload and PerformanceResourceTiming entries can describe fetched
    // async chunks that were never executed; importing those would let a
    // downloaded-but-untrusted module become an application entry point.
    Array.from(document.scripts || [])
      .filter((script) => script.type === "module")
      .map((script) => script.currentSrc || script.src)
      .map(sameOriginJavascriptAssetUrl)
      .filter(
        (url, index, urls) => Boolean(url) && urls.indexOf(url) === index,
      );
  const assetUrl = async (namePart) => {
    const urls = visibleAssetUrls();
    const direct = urls.find(
      (url) =>
        url.includes("/assets/") &&
        url.includes(namePart) &&
        url.split("?")[0].endsWith(".js"),
    );
    if (direct) return direct;

    // A source-file dependency table or quoted lazy-import path does not prove
    // that the referenced module has executed. Never fetch/traverse a module
    // graph to authorize a new import. Numeric initialized-cache discovery and
    // renderer scope discovery cover modern bundles; unsupported legacy graphs
    // remain unverified instead of executing an unused application chunk.
    return "";
  };
  const loadAppModule = async (namePart) => {
    if (!state.modulePromises.has(namePart)) {
      state.modulePromises.set(
        namePart,
        Promise.resolve()
          .then(async () => {
            const url = await assetUrl(namePart);
            if (!url) throw new Error(`Codex App asset not found: ${namePart}`);
            return await import(url);
          })
          .catch((error) => {
            state.modulePromises.delete(namePart);
            throw error;
          }),
      );
    }
    return await state.modulePromises.get(namePart);
  };
  // Current Desktop uses numeric Rspack ESM entrypoints instead of the old
  // semantic Vite chunk names. Re-import only exact loaded same-origin entry
  // URLs (an ESM cache hit), then inspect initialized exports without invoking
  // the runtime, factories, export getters, or application constructors.
  const discoverCodexWebpackModelPicker = async (patchedCaches) => {
    const entryUrls = codexLoadedWebpackEntryUrls(
      Array.from(document.scripts || []).map((script) => ({
        src: script.src,
        type: script.type,
      })),
      document.baseURI || window.location?.href || globalThis.location?.href,
    );
    // Keep entry-backed discovery fail-closed while imports are unresolved.
    // The completed candidate scan below is authoritative when every entry
    // import succeeds and no validated native atom is present.
    const priorNativeVisibilityRequired =
      state.nativeReasoningVisibilityRequired === true;
    let entryImportsComplete = true;
    state.nativeReasoningVisibilityRequired =
      priorNativeVisibilityRequired || entryUrls.length > 0;
    state.nativeReasoningVisibilityAtoms = [];
    const namespaces = [];
    // Keep exact, previously imported namespaces as read-only inspection roots.
    // Re-awaiting a fulfilled ESM import used to publish an empty atom list on
    // every routine scan, allowing a concurrent guardian probe to see a false
    // Unverified transition. Cached entries can be inspected synchronously;
    // new/failed entries still clear proof until their fresh scan completes.
    const initializedNamespaces = state.webpackPickerNamespaces;
    for (const url of initializedNamespaces.keys()) {
      if (!entryUrls.includes(url)) initializedNamespaces.delete(url);
    }
    for (const url of entryUrls) {
      if (!installationIsCurrent()) return [];
      const key = `webpack-entry:${url}`;
      const modulePromises = state.modulePromises;
      if (!modulePromises.has(key)) {
        const promise = import(url).catch((error) => {
          // Reinjection can replace the promise map or this exact entry. A
          // failed old import must not evict a successor installation's job.
          if (modulePromises.get(key) === promise) modulePromises.delete(key);
          throw error;
        });
        modulePromises.set(key, promise);
      }
      try {
        let namespace = initializedNamespaces.get(url);
        if (!namespace) {
          namespace = await modulePromises.get(key);
          if (!installationIsCurrent()) return [];
          initializedNamespaces.set(url, namespace);
        }
        namespaces.push(namespace);
      } catch (error) {
        if (!installationIsCurrent()) return [];
        entryImportsComplete = false;
        recordFailure(error);
      }
    }
    if (!installationIsCurrent()) return [];
    const candidates = codexInitializedWebpackPickerCandidates(namespaces);
    state.nativeReasoningVisibilityRequired =
      candidates.nativeReasoningVisibilityRequired === true ||
      !entryImportsComplete;
    state.nativeReasoningVisibilityAtoms =
      candidates.nativeReasoningVisibilityAtoms;
    // Rspack can keep the app-server registry in an initialized numeric module
    // cache while the current React scope contains only its query client. Keep
    // the validated registry classes on the shared discovery state so the
    // continuation client refresh can bind the exact local manager.
    state.scopedAppServerRegistryClasses = candidates.registries || [];
    state.appServerStatusAtoms = candidates.appServerStatusAtoms || [];
    state.appServerStatusBindings = candidates.appServerStatusBindings || [];
    for (const prototype of candidates.queryObserverPrototypes) {
      try {
        patchCodexModelReasoningQueryObserverPrototype(prototype);
      } catch (error) {
        recordFailure(error);
      }
    }
    let queryClientCount = 0;
    for (const client of candidates.queryClients) {
      if (patchCodexModelReasoningQueryClient(client, patchedCaches))
        queryClientCount += 1;
    }
    // An initialized export can keep an unmounted scope alive. It may expose
    // a cache to patch, but only a completed current React scan establishes
    // ownership for native visibility or continuation authorization.
    for (const scope of candidates.scopes) {
      try {
        if (
          patchCodexModelReasoningQueryClient(
            codexScopeQueryClient(scope),
            patchedCaches,
          )
        )
          queryClientCount += 1;
      } catch (error) {
        recordFailure(error);
      }
    }
    state.webpackPickerDiscovery = {
      entryCount: entryUrls.length,
      runtimeCount: candidates.runtimeCount,
      moduleCount: candidates.moduleCount,
      candidateCount: candidates.candidateCount,
      queryClientCount,
      registryCount: (candidates.registries || []).length,
      observerPrototypeCount: candidates.queryObserverPrototypes.length,
      nativeVisibilityRequired: state.nativeReasoningVisibilityRequired,
      nativeVisibilityAtomCount:
        candidates.nativeReasoningVisibilityAtoms.length,
      truncated: candidates.truncated,
    };
    // Picker cache discovery is deliberately NOT continuation authorization.
    // A cache or an export with sendRequest is never admitted as an RPC client.
    return candidates.scopes;
  };
  const localCatalogFromModule = (module) => {
    // 26.825+ exports both an unresolved RpcPromise (`appHost`) and the
    // initialized RpcStub (`appServices`). Prefer the initialized service;
    // otherwise the first shallow export looks valid but fails inside
    // readStatus/readSnapshot.
    const initialized = module?.appServices?.localThreadCatalog;
    if (initialized && typeof initialized.requestStartupSync === "function")
      return initialized;
    const roots = Object.values(module).filter(
      (item) =>
        item && (typeof item === "object" || typeof item === "function"),
    );
    for (const root of roots) {
      const catalog = root.localThreadCatalog;
      if (catalog && typeof catalog.requestStartupSync === "function")
        return catalog;
    }
    return null;
  };
  const summarizeCatalogStatus = (status, requested) => {
    const local = Array.isArray(status?.hosts)
      ? status.hosts.find((host) => host?.hostId === "local")
      : null;
    return {
      requested,
      complete: local?.isComplete ?? null,
      revision: local?.revision ?? status?.revision ?? null,
      source: "status",
    };
  };
  // 新版 Codex/ChatGPT App 用 localThreadCatalog 保存统一侧边栏目录。这里只调用
  // App 自己的 RPC 同步服务，不直接改 codex-dev.db 或历史 provider 元数据。
  const historySyncAttemptLimit = 5;
  const triggerLocalThreadCatalogSync = ({ explicit = false } = {}) => {
    if (
      !installationIsCurrent() ||
      state.historySyncPromise ||
      state.historySync?.complete === true ||
      monotonicNow() < (state.historySyncRetryAt || 0) ||
      (!explicit && (state.historySyncAttempts || 0) >= historySyncAttemptLimit)
    )
      return;

    // This RPC belongs to the document, not the injection generation. Share
    // the in-flight job and its budget across reinjections; a hung native RPC
    // cannot be cancelled, so do not start another one on top of it.
    state.historySyncAttempts = Math.min(
      (state.historySyncAttempts || 0) + 1,
      historySyncAttemptLimit,
    );
    const job = Promise.resolve()
      .then(async () => {
        const module = await loadAppModule("rpc-");
        const catalog = localCatalogFromModule(module);
        if (!catalog || typeof catalog.requestStartupSync !== "function")
          throw new Error(
            "Codex App localThreadCatalog RPC service was not found",
          );

        // 26.825+ exposes readStatus and can report a complete local catalog before
        // requestStartupSync. Do not wait on a redundant startup sync RPC forever.
        if (typeof catalog.readStatus === "function") {
          const summary = await Promise.resolve()
            .then(() => catalog.readStatus())
            .then((status) => summarizeCatalogStatus(status, false))
            .catch((error) => {
              recordFailure(error);
              return null;
            });
          if (summary?.complete === true) {
            state.historySync = summary;
            return;
          }
          if (summary) {
            state.historySync = { ...summary, requested: true, pending: true };
            await catalog.requestStartupSync();
            state.historySync = summarizeCatalogStatus(
              await catalog.readStatus(),
              true,
            );
            return;
          }
        }

        // Older builds expose readSnapshot instead of readStatus. Preserve that
        // path without retaining the potentially large first snapshot.
        const readSnapshotSummary = async () => {
          const snapshot =
            typeof catalog.readSnapshot === "function"
              ? await catalog.readSnapshot()
              : null;
          return {
            count: Array.isArray(snapshot?.entries)
              ? snapshot.entries.length
              : null,
            complete: snapshot?.isComplete ?? null,
          };
        };
        const before = await readSnapshotSummary();
        state.historySync = {
          requested: true,
          beforeCount: before.count,
          afterCount: null,
          complete: null,
          source: "snapshot",
          pending: true,
        };
        await catalog.requestStartupSync();
        const after = await readSnapshotSummary();
        state.historySync = {
          ...state.historySync,
          afterCount: after.count,
          complete: after.complete,
          pending: false,
        };
      })
      .catch((error) => {
        state.historySync = {
          requested: false,
          error: String(error?.message || error),
        };
        recordFailure(error);
      })
      .finally(() => {
        if (state.historySyncPromise !== job) return;
        state.historySyncPromise = null;
        state.historySyncRetryAt =
          monotonicNow() + 5000 * 2 ** (state.historySyncAttempts - 1);
      });
    state.historySyncPromise = job;
  };
  /*__CCSWITCH_APP_SERVER_MODEL_LIST_SCOPE_CORE__*/
  const patchModelListResult = (result) => {
    if (result == null) return false;
    if (state.payload?.catalogAvailable !== true) return false;
    let changed = false;
    if (Array.isArray(result) && patchModelArray(result, true, true))
      changed = true;
    if (Array.isArray(result?.data) && patchModelArray(result.data, true, true))
      changed = true;
    if (
      Array.isArray(result?.models) &&
      patchModelArray(result.models, true, true)
    )
      changed = true;
    if (
      Array.isArray(result?.result) &&
      patchModelArray(result.result, true, true)
    )
      changed = true;
    if (
      Array.isArray(result?.result?.data) &&
      patchModelArray(result.result.data, true, true)
    )
      changed = true;
    if (
      Array.isArray(result?.result?.models) &&
      patchModelArray(result.result.models, true, true)
    )
      changed = true;
    if (
      Array.isArray(result?.pages?.[0]?.data) &&
      patchModelArray(result.pages[0].data, true, true)
    )
      changed = true;
    if (
      Array.isArray(result?.message?.result?.data) &&
      patchModelArray(result.message.result.data, true, true)
    )
      changed = true;
    if (
      Array.isArray(result?.message?.result?.models) &&
      patchModelArray(result.message.result.models, true, true)
    )
      changed = true;
    if (patchModelContainer(result, true)) changed = true;
    return changed;
  };
  const patchAppServerResult = (method, result, scope, client, params) => {
    if (
      !isModelListMethod(method) ||
      !isCurrentModelListScope(scope, client, params)
    )
      return result;
    patchModelListResult(result);
    return result;
  };
  const patchRequestClient = (client) => {
    if (!installationIsCurrent()) return false;
    const sendRequest = codexDeclaredMethod(client, "sendRequest");
    if (!sendRequest || !isLocalAppServerTarget(client, null)) return false;
    const retainVerifiedClient = () => {
      state.appServerClients = Array.isArray(state.appServerClients)
        ? state.appServerClients
        : [];
      if (!state.appServerClients.includes(client))
        state.appServerClients.push(client);
      return true;
    };
    if (
      !appServerRequestClientNeedsPatch(client) &&
      codexVerifiedAppServerOriginalRequest(
        client,
        appServerRequestPatchVersion,
      )
    )
      return retainVerifiedClient();
    try {
      const previousOriginal = Object.getOwnPropertyDescriptor(
        client,
        "__ccSwitchOriginalSendRequest",
      )?.value;
      const original =
        typeof previousOriginal === "function"
          ? previousOriginal
          : sendRequest.bind(client);
      const wrapper = async function ccSwitchPatchedSendRequest(
        method,
        params,
        options,
      ) {
        rememberCodexUserTurnAction(method, params);
        const normalizedParams = normalizeAppServerRequestParams(
          method,
          params,
        );
        const actualMethod = appServerMethod(method, params);
        const modelListScope = captureModelListScope(
          actualMethod,
          normalizedParams,
          client,
        );
        try {
          const result = await original(method, normalizedParams, options);
          return patchAppServerResult(
            actualMethod,
            result,
            modelListScope,
            client,
            normalizedParams,
          );
        } catch (error) {
          if (!isGuardianV2FeatureTomlError(error)) throw error;
          const fallbackParams = guardianV2FallbackRequestParams(
            method,
            normalizedParams,
          );
          if (fallbackParams === normalizedParams) throw error;
          state.guardianV2FallbackCount =
            (state.guardianV2FallbackCount || 0) + 1;
          const result = await original(method, fallbackParams, options);
          return patchAppServerResult(
            actualMethod,
            result,
            modelListScope,
            client,
            fallbackParams,
          );
        }
      };
      Object.defineProperty(wrapper, "__ccSwitchRequestHook", {
        value: Object.freeze({
          client,
          original,
          version: appServerRequestPatchVersion,
        }),
      });
      client.__ccSwitchOriginalSendRequest = original;
      client.sendRequest = wrapper;
      client.__ccSwitchModelRequestPatch = appServerRequestPatchVersion;
      if (
        codexVerifiedAppServerOriginalRequest(
          client,
          appServerRequestPatchVersion,
        ) !== original
      )
        throw new Error(
          "Codex request client did not accept the guarded activity hook",
        );
      return retainVerifiedClient();
    } catch (error) {
      // Non-writable real clients can reject assignments silently as well as
      // throwing. Never retain one without proof that its activity hook owns
      // the live sendRequest method, even if an older discovery retained it.
      state.appServerClients = (state.appServerClients || []).filter(
        (candidate) => candidate !== client,
      );
      recordFailure(error);
      return false;
    }
  };
  const reactRootValue = (value) => {
    let current = value;
    let hops = 0;
    try {
      while (current?.return && hops < 2048) {
        current = current.return;
        hops += 1;
      }
    } catch {}
    const active = Object.getOwnPropertyDescriptor(
      current?.stateNode || {},
      "current",
    )?.value;
    return active || current || value;
  };
  const appendReactRootsFromNode = (node, values, seen, owners) => {
    for (const key of Object.keys(node || {})) {
      if (
        !key.startsWith("__reactContainer") &&
        !key.startsWith("__reactFiber") &&
        !key.startsWith("__reactInternalInstance")
      )
        continue;
      const field = Object.getOwnPropertyDescriptor(node, key);
      if (!field || !("value" in field)) continue;
      const value = reactRootValue(field.value);
      if (value && owners) {
        if (!owners.has(value)) owners.set(value, []);
        owners.get(value).push(() => {
          const attached =
            node === document.getElementById("root") ||
            node === document.body ||
            node === document.documentElement ||
            (typeof Node !== "undefined" &&
              node instanceof Node &&
              node.isConnected);
          const current = Object.getOwnPropertyDescriptor(node, key);
          return (
            attached &&
            current &&
            "value" in current &&
            reactRootValue(current.value) === value
          );
        });
      }
      if (value && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
  };
  const initialReactNodes = () =>
    [
      document.getElementById("root") || document.body,
      document.documentElement,
    ].filter(Boolean);
  const drainPendingReactNodes = () => {
    const pending = Array.from(state.pendingReactNodes || []);
    state.pendingReactNodes.clear();
    return pending;
  };
  const scheduleHistoryLineageHydration = (manager) => {
    if (
      !state.historyQueryRefreshCompleted ||
      state.historyLineageHydrationPromise ||
      state.historyLineageHydrationCompleted ||
      typeof manager?.getCachedConversations !== "function" ||
      typeof manager?.getConversation !== "function" ||
      typeof manager?.updateConversationState !== "function" ||
      typeof manager?.setConversation !== "function" ||
      typeof manager?.resumeConversationForUnavailableOwner !== "function"
    )
      return;
    const wallNow = Date.now();
    if (wallNow < (state.historyLineageHydrationRetryAt || 0)) return;
    state.historyLineageHydrationRetryAt = wallNow + 30000;
    state.historyLineageHydrationPromise = Promise.resolve()
      .then(() => rehydrateStaleHistoryLineages(manager))
      .then((result) => {
        state.historyLineageHydration = result;
        for (const failure of result.failed || []) recordFailure(failure.error);
        state.historyLineageHydrationCompleted =
          (result.deferred || []).length === 0 &&
          (result.failed || []).length === 0;
        if (state.historyLineageHydrationCompleted)
          state.historyManagerCandidates.clear();
        return result;
      })
      .catch((error) => {
        state.historyLineageHydration = {
          repaired: [],
          deferred: [],
          failed: [{ error: String(error?.message || error) }],
        };
        recordFailure(error);
      })
      .finally(() => {
        state.historyLineageHydrationPromise = null;
      });
  };
  // Discovery already has a 4ms/100-Fiber work budget. Wait for another
  // public task, not an idle window: recurring unrelated React commits can
  // otherwise invalidate a large inventory before its idle slices complete.
  const yieldReactDiscovery = async () => {
    const scheduler = globalThis.scheduler;
    if (typeof scheduler?.yield === "function") {
      try {
        await scheduler.yield();
        return;
      } catch {
        // A denied/unavailable scheduler must not strand an in-flight walk.
      }
    }
    await new Promise((resolve) => {
      let channel;
      const closeOwnedPorts = () => {
        for (const port of [channel?.port1, channel?.port2]) {
          if (!port) continue;
          try {
            port.onmessage = null;
          } catch {}
          try {
            port.close();
          } catch {}
        }
      };
      if (typeof globalThis.MessageChannel === "function") {
        try {
          channel = new globalThis.MessageChannel();
          channel.port1.onmessage = () => {
            closeOwnedPorts();
            resolve();
          };
          channel.port2.postMessage(null);
          return;
        } catch {
          closeOwnedPorts();
        }
      }
      // Preserve the established fallback on older renderer platforms.
      if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  };
  const monotonicNow = () =>
    typeof performance?.now === "function" ? performance.now() : Date.now();
  const patchReactAppServerClients = async (startingNodes, patchedCaches) => {
    if (!installationIsCurrent()) return 0;
    if (state.reactDiscoveryPromise) return await state.reactDiscoveryPromise;
    const discovery = (async () => {
      const roots = [];
      const rootSeen = new Set();
      const rootOwners = new Map();
      const clientOwners = new Map();
      const fullScan = startingNodes.some(
        (node) =>
          node &&
          (node === document.getElementById("root") ||
            node === document.body ||
            node === document.documentElement),
      );
      const retainClient = (client, path) => {
        if (!clientOwners.has(client)) clientOwners.set(client, []);
        clientOwners.get(client).push(() => {
          let entry = path;
          for (let depth = 0; entry && depth <= 16; depth += 1) {
            if (!entry.parent)
              return (rootOwners.get(entry.value) || []).some((current) =>
                current(),
              );
            const field = Object.getOwnPropertyDescriptor(
              entry.parent.value,
              entry.key,
            );
            if (!field || !("value" in field) || field.value !== entry.value)
              return false;
            entry = entry.parent;
          }
          return false;
        });
      };
      const nodeQueue = startingNodes.filter(Boolean);
      let nodeCursor = 0;
      while (nodeCursor < nodeQueue.length) {
        if (!installationIsCurrent()) return 0;
        const sliceDeadline = monotonicNow() + 4;
        let sliceCount = 0;
        while (
          nodeCursor < nodeQueue.length &&
          sliceCount < 800 &&
          monotonicNow() < sliceDeadline
        ) {
          sliceCount += 1;
          const node = nodeQueue[nodeCursor++];
          appendReactRootsFromNode(node, roots, rootSeen, rootOwners);
          try {
            for (const child of Array.from(node?.childNodes || []))
              nodeQueue.push(child);
          } catch {}
        }
        if (nodeCursor < nodeQueue.length) await yieldReactDiscovery();
      }

      const queue = roots.map((value) => ({ value, depth: 0 }));
      const seen = new Set();
      let cursor = 0;
      let patched = 0;
      while (cursor < queue.length && seen.size < 140000) {
        if (!installationIsCurrent()) return 0;
        const sliceDeadline = monotonicNow() + 4;
        let sliceCount = 0;
        while (
          cursor < queue.length &&
          seen.size < 140000 &&
          sliceCount < 800 &&
          monotonicNow() < sliceDeadline
        ) {
          sliceCount += 1;
          const entry = queue[cursor++];
          const { value, depth } = entry;
          if (
            !value ||
            (typeof value !== "object" && typeof value !== "function") ||
            seen.has(value)
          )
            continue;
          seen.add(value);

          patchCodexModelReasoningQueryClient(value, patchedCaches);
          if (
            looksLikeAppServerRequestClient(value) &&
            patchRequestClient(value)
          ) {
            retainClient(value, entry);
            patched += 1;
          }
          const nestedClient = Object.getOwnPropertyDescriptor(
            value,
            "requestClient",
          )?.value;
          if (
            looksLikeAppServerRequestClient(nestedClient) &&
            patchRequestClient(nestedClient)
          ) {
            retainClient(nestedClient, {
              value: nestedClient,
              parent: entry,
              key: "requestClient",
            });
            patched += 1;
            if (
              state.historyManagerCandidates.size >= 8 &&
              !state.historyManagerCandidates.has(value)
            )
              state.historyManagerCandidates.clear();
            state.historyManagerCandidates.add(value);
            if (
              !state.historyQueryRefreshPromise &&
              !state.historyQueryRefreshCompleted &&
              typeof value?.threadStore?.refreshRecentConversations ===
                "function"
            ) {
              state.historyQueryRefreshPromise = Promise.resolve()
                .then(() =>
                  value.threadStore.refreshRecentConversations({
                    mode: "expanded",
                  }),
                )
                .then(() => {
                  state.historyQueryRefreshCompleted = true;
                })
                .catch((error) => {
                  state.historyQueryRefreshPromise = null;
                  state.historyQueryRefreshCompleted = false;
                  recordFailure(error);
                });
            }
            scheduleHistoryLineageHydration(value);
          }

          if (depth >= 14) continue;
          let descriptors = {};
          try {
            descriptors = Object.getOwnPropertyDescriptors(value);
          } catch {}
          for (const [key, descriptor] of Object.entries(descriptors)) {
            if (
              ![
                "window",
                "alternate",
                "return",
                "ownerDocument",
                "parentNode",
                "parentElement",
                "nextSibling",
                "previousSibling",
              ].includes(key) &&
              "value" in descriptor
            ) {
              const child = descriptor.value;
              if (
                child &&
                ((typeof child === "object" &&
                  !(typeof Node !== "undefined" && child instanceof Node)) ||
                  typeof child === "function")
              ) {
                queue.push({
                  value: child,
                  depth: depth + 1,
                  parent: entry,
                  key,
                });
              }
            }
          }
        }
        if (cursor < queue.length && seen.size < 140000)
          await yieldReactDiscovery();
      }
      if (!installationIsCurrent()) return 0;
      const previousOwners =
        state.reactAppServerClientOwners instanceof Map
          ? state.reactAppServerClientOwners
          : new Map();
      const complete = cursor >= queue.length && nodeCursor >= nodeQueue.length;
      const currentOwners =
        fullScan && complete ? new Map() : new Map(previousOwners);
      for (const [client, checks] of clientOwners)
        currentOwners.set(client, checks);
      state.reactAppServerClientOwners = currentOwners;
      state.appServerClients = (state.appServerClients || []).filter((client) =>
        codexAppServerClientHasCurrentOwner(client),
      );
      state.reactRequestClientPatched =
        state.reactRequestClientPatched || patched > 0;
      state.historyQueryPatch = {
        patched: Boolean(state.reactRequestClientPatched),
        clientCount: patched,
        refreshRequested: Boolean(state.historyQueryRefreshCompleted),
        lineageHydration: state.historyLineageHydration || null,
      };
      return patched;
    })();
    state.reactDiscoveryPromise = discovery;
    try {
      return await discovery;
    } finally {
      if (state.reactDiscoveryPromise === discovery)
        state.reactDiscoveryPromise = null;
    }
  };
  const installReactRootObserver = () => {
    if (state.reactRootObserver || typeof MutationObserver !== "function")
      return;
    const target = document.documentElement || document.body;
    if (!target) return;
    state.reactRootObserver = new MutationObserver((records) => {
      if (!installationIsCurrent()) return;
      let mutated = false;
      for (const record of records) {
        const added = record.addedNodes || [];
        const removed = record.removedNodes || [];
        if (!added.length && !removed.length) continue;
        mutated = true;
        // A removal can replace a dependency provider without adding a DOM
        // node. Queue its still-current parent as well; never keep a completed
        // ownership snapshot just because the pending-node set was drained.
        const nodes = added.length ? added : [record.target];
        for (const node of nodes) {
          if (!node || (typeof node !== "object" && typeof node !== "function"))
            continue;
          state.pendingReactNodes.add(node);
          if (state.pendingReactNodes.size > 128) {
            state.pendingReactNodes.clear();
            state.pendingReactNodes.add(
              document.getElementById("root") || document.body,
            );
          }
        }
      }
      if (mutated) state.reactMutationGeneration += 1;
    });
    state.reactRootObserver.observe(target, { childList: true, subtree: true });
  };
  const installAppServerPatch = async () => {
    if (!installationIsCurrent()) return;
    const refreshMountedAppServerScopeHints = (patchedCaches) => {
      if (!installationIsCurrent()) return 0;
      const warmScopes = codexCurrentAppServerScopeHints();
      if (!warmScopes.length) return 0;
      state.appServerScopeHints = warmScopes;
      // A canonical status brand can authorize its exact mounted RPC owner,
      // but it is not a complete inventory of native picker cache owners. Keep
      // a current complete snapshot; otherwise mark the warm subset incomplete
      // until the independent current-tree inventory has proved every owner.
      if (!codexRendererScopeSnapshotIsCurrent()) {
        state.scopedAppServerScopeScanComplete = false;
        state.scopedAppServerScopeCandidates = new Set(warmScopes);
      }
      const patched = refreshCodexScopedAppServerClients(
        state.scopedAppServerScopeCandidates,
        state.scopedAppServerRegistryClasses || [],
        patchedCaches,
      );
      if (patched > 0) state.appServerPatchInstalled = true;
      return patched;
    };
    const patchedCaches = new Set();
    // Rebinding a known, positively mounted family client is synchronous. Do
    // it before async Webpack/Fiber inventory so reinjection immediately
    // restores guarded continuation without waiting for a full picker scan.
    let modulePatched = 0;
    if (state.scopedAppServerSeedRefreshPending === true) {
      state.scopedAppServerSeedRefreshPending = false;
      modulePatched = refreshCodexScopedAppServerClients(
        codexMountedRetainedScopeCandidates(
          state.scopedAppServerScopeCandidates || [],
        ),
        state.scopedAppServerRegistryClasses || [],
        patchedCaches,
      );
    }
    let patched = modulePatched;
    if (modulePatched > 0) state.appServerPatchInstalled = true;
    const wallNow = Date.now();
    // Picker proof must not wait for continuation/request-client discovery.
    // Numeric modules may initialize after installation even when no RPC client
    // can be authorized. Retry unresolved native bindings in a bounded 5s loop;
    // a known initialized atom only needs the regular 30s inventory refresh.
    if (
      !state.webpackPickerDiscoveryPromise &&
      (!state.webpackPickerDiscoveryRetryAt ||
        wallNow >= state.webpackPickerDiscoveryRetryAt)
    ) {
      state.webpackPickerDiscoveryRetryAt = wallNow + 5000;
      // Execute cached inspection synchronously, but never await browser module
      // imports here: a renderer-owned import may remain pending indefinitely.
      // It must not prevent compatibility installation or its heartbeat.
      const discovery = discoverCodexWebpackModelPicker(patchedCaches);
      state.webpackPickerDiscoveryPromise = discovery;
      const ownsDiscovery = () =>
        installationIsCurrent() &&
        state.webpackPickerDiscoveryPromise === discovery;
      void discovery
        .then(() => {
          if (!ownsDiscovery()) return;
          // New initialized status atoms can bind the exact current manager
          // immediately, without gating the canonical tree scan on this import.
          refreshMountedAppServerScopeHints(patchedCaches);
          const known =
            Array.isArray(state.nativeReasoningVisibilityAtoms) &&
            state.nativeReasoningVisibilityAtoms.length === 1;
          state.webpackPickerDiscoveryRetryAt =
            Date.now() + (known ? 30000 : 5000);
        })
        .catch((error) => {
          if (!ownsDiscovery()) return;
          state.webpackPickerDiscoveryRetryAt = Date.now() + 5000;
          recordFailure(error);
        })
        .finally(() => {
          if (ownsDiscovery()) state.webpackPickerDiscoveryPromise = null;
        });
    }
    if (
      !state.appServerModuleRetryAt ||
      wallNow >= state.appServerModuleRetryAt
    ) {
      try {
        // 26.1007+ merges the signal module into app-shared. Current Desktop
        // bundles export AppServerRegistry from app-server-manager-hooks, while
        // some older bundles keep only a runtime instance in app-initial.
        // Discover the explicit hook chunk first, then retain both fallbacks.
        const discoverScopedModules = async () => {
          let scopedPatched = 0;
          // The picker scheduler owns numeric inventory independently. Never
          // await its import here or launch a competing discovery: current
          // scope ownership can be proved while that renderer import is pending.
          // Scope/cache discovery must not depend on finding an obsolete named
          // bundle. The current React provider retains the initialized scope
          // even when every semantic Vite import is unavailable.
          const rendererScopes = await codexRendererScopeCandidates();
          if (!installationIsCurrent()) return 0;
          // Module cache inventory is not mounted scope ownership. Keep the
          // exact current React snapshot canonical for all readiness/mutation
          // consumers; orphaned export scopes remain cache-only candidates.
          state.scopedAppServerScopeCandidates = new Set(rendererScopes);
          scopedPatched = refreshCodexScopedAppServerClients(
            rendererScopes,
            state.scopedAppServerRegistryClasses || [],
            patchedCaches,
          );
          const discover = async (module) => {
            if (!installationIsCurrent()) return 0;
            const result = await patchCodexScopedAppServerClients(
              module,
              patchedCaches,
            );
            return state.scopedAppServerDiscovery?.clientCount || result || 0;
          };
          try {
            const shared = await loadAppModule("app-shared-");
            scopedPatched = await discover(shared);
          } catch {}
          if (scopedPatched === 0) {
            try {
              const hooks = await loadAppModule("app-server-manager-hooks-");
              scopedPatched = await discover(hooks);
            } catch {}
          }
          if (scopedPatched === 0) {
            try {
              const initial = await loadAppModule("app-initial-");
              scopedPatched = await discover(initial);
            } catch {}
          }
          return scopedPatched;
        };
        try {
          if (!state.scopedAppServerDiscoveryPromise) {
            const discovery = discoverScopedModules();
            state.scopedAppServerDiscoveryPromise = discovery;
            void discovery.catch(recordFailure).finally(() => {
              if (state.scopedAppServerDiscoveryPromise === discovery)
                state.scopedAppServerDiscoveryPromise = null;
            });
          }
          // Scope discovery yields across large renderer trees. Keep the
          // installation/heartbeat alive while it binds the picker caches.
          modulePatched = state.scopedAppServerDiscovery?.clientCount || 0;
        } catch {}
        if (modulePatched === 0) {
          try {
            const module = await loadAppModule("app-server-manager-signals-");
            if (!installationIsCurrent()) return;
            modulePatched = patchAppServerModuleClients(module, patchedCaches);
          } catch {}
        }
        if (!installationIsCurrent()) return;
        patched += modulePatched;
        state.appServerModuleRetryAt = modulePatched > 0 ? 0 : wallNow + 30000;
      } catch (error) {
        recordFailure(error);
        state.appServerModuleRetryAt = wallNow + 30000;
      }
    }
    if (!installationIsCurrent()) return;
    installReactRootObserver();
    const fullScanDue =
      modulePatched === 0 &&
      (!state.reactInitialDiscoveryCompleted ||
        wallNow - (state.lastReactFullScanAt || 0) >= 30000);
    const incrementalScanDue =
      modulePatched === 0 &&
      state.pendingReactNodes.size > 0 &&
      wallNow - (state.lastReactIncrementalScanAt || 0) >= 5000;
    if (fullScanDue) {
      state.pendingReactNodes.clear();
      state.lastReactFullScanAt = wallNow;
      patched += await patchReactAppServerClients(
        initialReactNodes(),
        patchedCaches,
      );
      state.reactInitialDiscoveryCompleted = true;
    } else if (incrementalScanDue) {
      state.lastReactIncrementalScanAt = wallNow;
      patched += await patchReactAppServerClients(
        drainPendingReactNodes(),
        patchedCaches,
      );
    } else if (modulePatched > 0) {
      state.pendingReactNodes.clear();
    }
    if (!installationIsCurrent()) return;
    // React swaps its current Fiber during ordinary commits. That correctly
    // invalidates native proof immediately, but refreshing the owner snapshot
    // used to be trapped behind the unrelated 30s continuation-module cooldown.
    // Re-establish exact current scope ownership on the next bounded retry,
    // without accepting stale roots or turning a cache into RPC authorization.
    // Pending DOM nodes remain owned by the throttled React work above.
    if (
      state.nativeReasoningVisibilityRequired === true &&
      !state.pendingReactNodes.size &&
      !codexRendererScopeSnapshotIsCurrent() &&
      (!state.nativeReasoningScopeRetryAt ||
        wallNow >= state.nativeReasoningScopeRetryAt)
    ) {
      state.nativeReasoningScopeRetryAt = wallNow + 5000;
      try {
        const rendererScopes = await codexRendererScopeCandidates();
        if (!installationIsCurrent()) return;
        state.scopedAppServerScopeCandidates = new Set(rendererScopes);
        patched += refreshCodexScopedAppServerClients(
          rendererScopes,
          undefined,
          patchedCaches,
        );
      } catch (error) {
        recordFailure(error);
      }
    }
    // History refresh is optional and may wait on a renderer-owned request that
    // never settles during startup. It must not gate model-list patching or the
    // heartbeat interval; its promise already records completion/failure above.
    for (const manager of state.historyManagerCandidates)
      scheduleHistoryLineageHydration(manager);
    // Lineage repair may resume conversations and fetch every paginated turn.
    // Observe its state on a later heartbeat instead of awaiting renderer-owned
    // RPCs while the model-picker scheduler is being installed.
    state.historyQueryPatch = {
      ...(state.historyQueryPatch || {}),
      refreshRequested: Boolean(state.historyQueryRefreshCompleted),
      lineageHydration: state.historyLineageHydration || null,
    };
    if (state.payload?.catalogAvailable === true) {
      patched += refreshCodexScopedAppServerClients(
        undefined,
        state.scopedAppServerRegistryClasses || [],
        patchedCaches,
      );
      for (const cache of state.reasoningQueryCaches?.keys() || []) {
        try {
          patchCodexModelReasoningQueryCacheOnce(cache, patchedCaches);
        } catch (error) {
          recordFailure(error);
        }
      }
    }
    if (typeof reconcileCodexNativeReasoningVisibility === "function") {
      try {
        state.nativeReasoningVisibilityReconciliation =
          reconcileCodexNativeReasoningVisibility(
            codexNativeReasoningManagedEfforts(),
          );
      } catch (error) {
        recordFailure(error);
      }
    }
    state.appServerPatchInstalled = patched > 0;
    if (patched > 0 && state.historyQueryRefreshCompleted) {
      state.reactRequestClientPatchVersion = appServerRequestPatchVersion;
      state.appServerPatchVersion = appServerRequestPatchVersion;
    }
  };
  const patchMcpModelResponseData = (data) => {
    if (data?.type !== "mcp-response") return false;
    // Depending on the Desktop build, the MCP response is either nested under
    // `message`/`response` or carried directly by the envelope itself.
    const message = data.message || data.response || data;
    const requestId =
      message?.id != null
        ? String(message.id)
        : data?.id != null
          ? String(data.id)
          : "";
    if (!requestId || !(state.requestIds instanceof Map)) return false;
    const scope = state.requestIds.get(requestId);
    if (!scope) return false;
    state.requestIds.delete(requestId);
    if (!isCurrentModelListScope(scope, null, message?.params || data?.params))
      return false;
    const result = message?.result ?? data?.result;
    return patchModelListResult(result) || patchModelListResult(result?.data);
  };
  const installMessagePatch = () => {
    if (state.messagePatchInstalled) return;
    state.messagePatchInstalled = true;
    const originalDispatchEvent = window.dispatchEvent;
    const patchedDispatchEvent = function ccSwitchPatchedDispatchEvent(event) {
      try {
        const detail = event?.detail;
        const request = detail?.request;
        if (
          event?.type === "codex-message-from-view" &&
          detail?.type === "mcp-request" &&
          request?.method === "model/list"
        ) {
          const viewRequest = {
            ...request,
            hostId:
              detail?.hostId ??
              detail?.host_id ??
              request?.hostId ??
              request?.host_id,
          };
          const scope = captureModelListScope(
            "model/list",
            viewRequest,
            null,
            true,
          );
          if (scope) {
            request.params = { ...(request.params || {}), includeHidden: true };
            if (request.id != null)
              state.requestIds.set(String(request.id), scope);
          }
        }
        if (event?.type === "message") patchMcpModelResponseData(event.data);
      } catch (error) {
        recordFailure(error);
      }
      return originalDispatchEvent.call(this, event);
    };
    const messagePatchListener = (event) => {
      try {
        patchMcpModelResponseData(event?.data);
      } catch (error) {
        recordFailure(error);
      }
    };
    state.messagePatchOriginalDispatchEvent = originalDispatchEvent;
    state.messagePatchPatchedDispatchEvent = patchedDispatchEvent;
    state.messagePatchListener = messagePatchListener;
    window.dispatchEvent = patchedDispatchEvent;
    window.addEventListener("message", messagePatchListener, true);
  };
  const reactFiberKeys = (element) =>
    Object.keys(element || {}).filter(
      (key) =>
        key.startsWith("__reactFiber") ||
        key.startsWith("__reactInternalInstance") ||
        key.startsWith("__reactProps"),
    );
  // Codex app-server 会根据 requires_openai_auth 暴露 OAuth 状态；旧配置或缓存状态
  // 可能把 renderer 留在非 chatgpt 模式，这里只修复前端 context，不改请求路由。
  const authContextValueFrom = (element) => {
    for (const key of reactFiberKeys(element)) {
      for (let fiber = element?.[key]; fiber; fiber = fiber.return) {
        for (const value of [
          fiber.memoizedProps?.value,
          fiber.pendingProps?.value,
        ]) {
          if (
            value &&
            typeof value === "object" &&
            typeof value.setAuthMethod === "function" &&
            "authMethod" in value
          )
            return value;
        }
      }
    }
    return null;
  };
  const spoofChatGPTAuthMethod = (element) => {
    const auth = authContextValueFrom(element);
    if (!auth || auth.authMethod === "chatgpt") return false;
    try {
      auth.setAuthMethod("chatgpt");
      return true;
    } catch (error) {
      recordFailure(error);
      return false;
    }
  };
  const patchReactState = () => {
    const nodes = [
      document.body,
      ...document.querySelectorAll(
        "button, [role='menu'], [role='dialog'], [data-radix-popper-content-wrapper]",
      ),
    ].filter(Boolean);
    for (const node of nodes.slice(0, 220)) {
      spoofChatGPTAuthMethod(node);
    }
  };
  const run = async () => {
    if (state.runtimeGeneration !== installationGeneration) return;
    if (state.runPromise) return await state.runPromise;
    const job = (async () => {
      installMessagePatch();
      await installAppServerPatch();
      if (!installationIsCurrent()) return;
      void triggerLocalThreadCatalogSync();
      if (!state.catalogReleased) patchStatsig();
      patchReactState();
      syncNativeBooleanReasoningControls();
    })();
    state.runPromise = job;
    try {
      return await job;
    } finally {
      if (state.runPromise === job) state.runPromise = null;
    }
  };
  await run();
  if (state.runtimeGeneration === installationGeneration && !state.interval)
    state.interval = setInterval(() => {
      if (!state.runPromise) void run().catch(recordFailure);
    }, 1500);
  // The native history catalog is optional. Return the renderer compatibility
  // result immediately and let the existing heartbeat publish the eventual
  // status once the RPC settles.
  void triggerLocalThreadCatalogSync();
  const historySync = state.historySync || {
    requested: true,
    pending: Boolean(state.historySyncPromise),
    source: "pending",
  };
  return {
    status: "ok",
    modelCount: modelNames().length,
    available_models: modelNames(),
    catalogDiagnostics: codexModelCatalogDiagnostics(),
    pickerDiagnostics: codexModelPickerDiagnostics(),
    catalogPayloadPreserved: Boolean(state.catalogPayloadPreserved),
    reasoningQueryCacheCount: state.reasoningQueryCaches?.size || 0,
    appServerPatchInstalled: Boolean(state.appServerPatchInstalled),
    historySync,
    historyQueryPatch: state.historyQueryPatch || null,
    patchKey,
  };
})();
