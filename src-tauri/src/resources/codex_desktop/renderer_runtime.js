(async () => {
  const incomingPayload = __CCSWITCH_CATALOG_PAYLOAD__;
  if (__CCSWITCH_CATALOG_RELEASED__) incomingPayload.catalogReleased = true;
  const patchKey = __CCSWITCH_PATCH_KEY__;
  const state = window[patchKey] || {};
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
  const installationIsCurrent = () =>
    state.runtimeGeneration === installationGeneration;
  state.runPromise = null;
  state.reactDiscoveryPromise = null;
  state.scopedAppServerDiscoveryPromise = null;
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
    state.requestIds = new Map();
    state.modelListRequestScopes = new Map();
    state.appServerModuleRetryAt = 0;
    state.scopedAppServerScopes = new Set();
    state.scopedAppServerScopeCandidates = new Set();
    state.scopedAppServerRegistryClasses = [];
    state.scopedAppServerScopesScannedAt = null;
    state.pendingReactNodes = new Set();
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
  state.failures = state.failures || [];
  state.pendingReactNodes = state.pendingReactNodes || new Set();
  state.historyManagerCandidates = state.historyManagerCandidates || new Set();
  const recordFailure = (error) => {
    const message = String(error?.message || error);
    if (state.failures.at(-1) !== message) state.failures.push(message);
    state.failures = state.failures.slice(-20);
  };
  window[patchKey] = state;
  /*__CCSWITCH_MODEL_PATCH_CORE__*/
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
  /*__CCSWITCH_MODEL_PICKER_DIAGNOSTICS_CORE__*/
  state.readCodexModelPickerDiagnostics = codexModelPickerDiagnostics;
  /*__CCSWITCH_REQUEST_HEALTH_WARNING_CORE__*/
  /*__CCSWITCH_SUMMARY_HANDOFF_CORE__*/
  /*__CCSWITCH_CODEX_CONTINUATION_CORE__*/
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
  const visibleAssetUrls = () =>
    [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map(
        (link) => link.href,
      ),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter((url, index, urls) => Boolean(url) && urls.indexOf(url) === index);
  const assetUrl = async (namePart) => {
    const urls = visibleAssetUrls();
    const direct = urls.find(
      (url) =>
        url.includes("/assets/") &&
        url.includes(namePart) &&
        url.split("?")[0].endsWith(".js"),
    );
    if (direct) return direct;

    // Newer Codex builds keep only index-*.js visible and reference rpc/app chunks
    // from the Vite dependency table. Follow those same-origin module references
    // instead of depending on one hashed filename or Performance API behavior.
    const inspected = new Set();
    for (let index = 0; index < urls.length && index < 32; index += 1) {
      const url = urls[index];
      if (!url || inspected.has(url) || !url.split("?")[0].endsWith(".js"))
        continue;
      inspected.add(url);
      let source = "";
      try {
        source = await fetch(url).then((response) =>
          response.ok ? response.text() : "",
        );
      } catch {}
      for (const match of source.matchAll(/["'](\.\/[^"']+\.js)["']/g)) {
        const candidate = new URL(match[1], url).href;
        if (candidate.includes(namePart)) return candidate;
        if (!urls.includes(candidate)) urls.push(candidate);
      }
    }
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
  const triggerLocalThreadCatalogSync = async () => {
    if (!installationIsCurrent()) return state.historySync;
    if (state.historySyncPromise) return state.historySyncPromise;
    state.historySyncPromise = Promise.resolve()
      .then(async () => {
        const module = await loadAppModule("rpc-");
        const catalog = localCatalogFromModule(module);
        if (!catalog || typeof catalog.requestStartupSync !== "function")
          throw new Error(
            "Codex App localThreadCatalog RPC service was not found",
          );

        // 26.825+ exposes readStatus and can report a complete local catalog before
        // requestStartupSync. Do not wait on a redundant startup sync RPC forever.
        try {
          const status = await catalog.readStatus();
          const summary = summarizeCatalogStatus(status, false);
          if (summary.complete === true) {
            state.historySync = summary;
            return summary;
          }
          state.historySync = summarizeCatalogStatus(status, true);
          Promise.resolve(catalog.requestStartupSync())
            .then(async () => {
              try {
                state.historySync = summarizeCatalogStatus(
                  await catalog.readStatus(),
                  true,
                );
              } catch (error) {
                recordFailure(error);
              }
            })
            .catch(recordFailure);
          return state.historySync;
        } catch (error) {
          recordFailure(error);
        }

        // Older builds expose readSnapshot instead of readStatus. Preserve that
        // official cold-sweep path as a capability fallback. The request itself
        // remains fire-and-observe so optional history work cannot hold the
        // model-picker heartbeat or the CDP installation result open.
        try {
          const before =
            typeof catalog.readSnapshot === "function"
              ? await catalog.readSnapshot()
              : null;
          state.historySync = {
            requested: true,
            beforeCount: Array.isArray(before?.entries)
              ? before.entries.length
              : null,
            afterCount: null,
            complete: null,
            source: "snapshot",
            pending: true,
          };
          Promise.resolve()
            .then(() => catalog.requestStartupSync())
            .then(async () => {
              const after =
                typeof catalog.readSnapshot === "function"
                  ? await catalog.readSnapshot()
                  : null;
              state.historySync = {
                requested: true,
                beforeCount: Array.isArray(before?.entries)
                  ? before.entries.length
                  : null,
                afterCount: Array.isArray(after?.entries)
                  ? after.entries.length
                  : null,
                complete: after?.isComplete ?? null,
                source: "snapshot",
                pending: false,
              };
              if (after?.isComplete !== true) state.historySyncPromise = null;
            })
            .catch((error) => {
              state.historySync = {
                requested: false,
                error: String(error?.message || error),
              };
              recordFailure(error);
              state.historySyncPromise = null;
            });
          return state.historySync;
        } catch (error) {
          recordFailure(error);
        }
        throw new Error(
          "Codex App localThreadCatalog RPC service was not found",
        );
      })
      .catch((error) => {
        state.historySync = {
          requested: false,
          error: String(error?.message || error),
        };
        recordFailure(error);
        state.historySyncPromise = null;
        return state.historySync;
      });
    return state.historySyncPromise;
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
    if (!client || typeof client.sendRequest !== "function") return false;
    if (!isLocalAppServerTarget(client, null)) return false;
    state.appServerClients = Array.isArray(state.appServerClients)
      ? state.appServerClients
      : [];
    if (!state.appServerClients.includes(client))
      state.appServerClients.push(client);
    if (!appServerRequestClientNeedsPatch(client)) return true;
    try {
      const original =
        client.__ccSwitchOriginalSendRequest || client.sendRequest.bind(client);
      client.__ccSwitchOriginalSendRequest = original;
      client.sendRequest = async function ccSwitchPatchedSendRequest(
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
      client.__ccSwitchModelRequestPatch = appServerRequestPatchVersion;
      return true;
    } catch (error) {
      // rpc-BaVz... also exposes immutable RpcStub objects whose method shape
      // resembles AppServerRequestClient. Skip them and keep scanning React.
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
    return current || value;
  };
  const appendReactRootsFromNode = (node, values, seen) => {
    for (const key of Object.keys(node || {})) {
      if (
        !key.startsWith("__reactContainer") &&
        !key.startsWith("__reactFiber") &&
        !key.startsWith("__reactInternalInstance")
      )
        continue;
      const value = reactRootValue(node[key]);
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
  const yieldReactDiscovery = () =>
    new Promise((resolve) => {
      if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  const monotonicNow = () =>
    typeof performance?.now === "function" ? performance.now() : Date.now();
  const patchReactAppServerClients = async (startingNodes, patchedCaches) => {
    if (!installationIsCurrent()) return 0;
    if (state.reactDiscoveryPromise) return await state.reactDiscoveryPromise;
    const discovery = (async () => {
      const roots = [];
      const rootSeen = new Set();
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
          appendReactRootsFromNode(node, roots, rootSeen);
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
          const { value, depth } = queue[cursor++];
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
          )
            patched += 1;
          const nestedClient = value?.requestClient;
          if (
            looksLikeAppServerRequestClient(nestedClient) &&
            patchRequestClient(nestedClient)
          ) {
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
                queue.push({ value: child, depth: depth + 1 });
              }
            }
          }
        }
        if (cursor < queue.length && seen.size < 140000)
          await yieldReactDiscovery();
      }
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
      for (const record of records) {
        for (const node of record.addedNodes || []) {
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
    });
    state.reactRootObserver.observe(target, { childList: true, subtree: true });
  };
  const installAppServerPatch = async () => {
    if (!installationIsCurrent()) return;
    const patchedCaches = new Set();
    let patched = 0;
    let modulePatched = 0;
    const wallNow = Date.now();
    if (
      !state.appServerModuleRetryAt ||
      wallNow >= state.appServerModuleRetryAt
    ) {
      try {
        // 26.1007+ merges the signal module into app-shared. Discover the
        // initialized local manager from its declared registry and app scope.
        try {
          const shared = await loadAppModule("app-shared-");
          if (!installationIsCurrent()) return;
          if (!state.scopedAppServerDiscoveryPromise) {
            const discovery = patchCodexScopedAppServerClients(
              shared,
              patchedCaches,
            );
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
          const module = await loadAppModule("app-server-manager-signals-");
          if (!installationIsCurrent()) return;
          modulePatched = patchAppServerModuleClients(module, patchedCaches);
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
      !state.reactInitialDiscoveryCompleted ||
      (modulePatched === 0 &&
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
        undefined,
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
      void run();
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
