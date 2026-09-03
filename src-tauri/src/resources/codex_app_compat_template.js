(async () => {
  const payload = __CODEX_PAYLOAD_JSON__;
  const patchKey = "__CODEX_PATCH_KEY__";
  const state = window[patchKey] || {};
  state.payload = payload;
  state.requestIds = state.requestIds || new Set();
  state.modulePromises = state.modulePromises || new Map();
  state.failures = state.failures || [];
  window[patchKey] = state;
  __CODEX_MODEL_PICKER_CORE__;
  __CODEX_GUARDIAN_V2_COMPAT_CORE__;
  __CODEX_COMPACTION_ITEM_CORE__;
  const installModelPickerSpacingFix = () => {
    const styleId = `${patchKey}-model-picker-spacing`;
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        [data-radix-popper-content-wrapper][data-ccswitch-model-picker="true"],
        [data-radix-popper-content-wrapper]:has([data-model-selected]) {
          max-width: min(92vw, 420px) !important;
          min-width: 280px !important;
        }
        [data-radix-popper-content-wrapper][data-ccswitch-model-picker="true"] [role="menuitem"],
        [data-radix-popper-content-wrapper]:has([data-model-selected]) [role="menuitem"] {
          min-height: 32px !important;
          padding-block: 6px !important;
          white-space: nowrap !important;
          flex-shrink: 0 !important;
        }
        [data-radix-popper-content-wrapper][data-ccswitch-model-picker="true"] [role="menuitem"] > *,
        [data-radix-popper-content-wrapper]:has([data-model-selected]) [role="menuitem"] > * {
          min-width: 0 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    const labels = new Set(
      [
        ...modelNames(),
        ...(currentPayload().models || []).flatMap((model) => [
          model?.displayName,
          model?.display_name,
          model?.name,
        ]),
      ]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    );
    for (const wrapper of document.querySelectorAll(
      "[data-radix-popper-content-wrapper]",
    )) {
      if (wrapper.querySelector("[data-model-selected]")) {
        wrapper.setAttribute("data-ccswitch-model-picker", "true");
        continue;
      }
      const items = Array.from(wrapper.querySelectorAll('[role="menuitem"]'));
      if (
        items.some((item) => {
          const text = String(item.textContent || "").trim();
          return (
            text && Array.from(labels).some((label) => text.includes(label))
          );
        })
      ) {
        wrapper.setAttribute("data-ccswitch-model-picker", "true");
      }
    }
  };
  const patchStatsigConfig = (name, config, repairLegacyPollution = false) => {
    const prepared = prepareStatsigDynamicConfig(
      name,
      config,
      repairLegacyPollution,
    );
    config = prepared.config;
    if (!prepared.patchModelWhitelist) return config;
    const value = config?.value;
    if (!value || typeof value !== "object") return config;
    const available = Array.isArray(value.available_models)
      ? [...value.available_models]
      : [];
    let changed = false;
    for (const name of modelNames()) {
      if (!available.includes(name)) {
        available.push(name);
        changed = true;
      }
    }
    const routed = modelNames().filter((name) => available.includes(name));
    const routedSet = new Set(modelNames());
    const untouched = available.filter((name) => !routedSet.has(name));
    const ordered = [...routed, ...untouched];
    if (available.some((name, index) => name !== ordered[index]))
      changed = true;
    const nextValue = {
      ...value,
      available_models: ordered,
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
      if (client.__ccSwitchStatsigPatchVersion !== "2") {
        const repairingLegacyPatch =
          client.__ccSwitchModelWhitelistPatched === true;
        const original =
          client.__ccSwitchOriginalGetDynamicConfig ||
          client.getDynamicConfig.bind(client);
        client.__ccSwitchOriginalGetDynamicConfig = original;
        client.getDynamicConfig = (name, options) =>
          patchStatsigConfig(
            name,
            original(name, options),
            repairingLegacyPatch,
          );
        client.__ccSwitchStatsigPatchVersion = "2";
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
  const assetUrl = (namePart) => {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map(
        (link) => link.href,
      ),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return (
      urls.find(
        (url) =>
          url.includes("/assets/") &&
          url.includes(namePart) &&
          url.split("?")[0].endsWith(".js"),
      ) || ""
    );
  };
  const loadAppModule = async (namePart) => {
    if (!state.modulePromises.has(namePart)) {
      state.modulePromises.set(
        namePart,
        Promise.resolve()
          .then(async () => {
            const url = assetUrl(namePart);
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
  // 新版 Codex/ChatGPT App 用 localThreadCatalog 保存统一侧边栏目录。这里只调用
  // App 自己的 RPC 同步服务，不直接改 codex-dev.db 或历史 provider 元数据。
  const triggerLocalThreadCatalogSync = async () => {
    if (state.historySyncPromise) return await state.historySyncPromise;
    state.historySyncPromise = Promise.resolve()
      .then(async () => {
        const module = await loadAppModule("rpc-");
        const roots = Object.values(module).filter(
          (item) =>
            item && (typeof item === "object" || typeof item === "function"),
        );
        for (const root of roots) {
          try {
            const catalog = root.localThreadCatalog;
            if (!catalog || typeof catalog.requestStartupSync !== "function")
              continue;
            const before =
              typeof catalog.readSnapshot === "function"
                ? await catalog.readSnapshot()
                : null;
            await catalog.requestStartupSync();
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
            };
            if (after?.isComplete !== true) {
              setTimeout(() => {
                state.historySyncPromise = null;
              }, 10000);
            }
            return state.historySync;
          } catch (error) {
            state.failures.push(String(error?.message || error));
          }
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
        state.failures.push(state.historySync.error);
        state.historySyncPromise = null;
        return state.historySync;
      });
    return await state.historySyncPromise;
  };
  const appServerMethod = (method, params) =>
    method === "send-cli-request-for-host" && params?.method
      ? String(params.method)
      : String(method || "");
  const isModelListMethod = (method) =>
    method === "list-models-for-host" || method === "model/list";
  const patchModelListResult = (result) => {
    if (result == null) return false;
    let changed = false;
    if (Array.isArray(result) && patchModelArray(result, true)) changed = true;
    if (Array.isArray(result?.data) && patchModelArray(result.data, true))
      changed = true;
    if (Array.isArray(result?.models) && patchModelArray(result.models, true))
      changed = true;
    if (Array.isArray(result?.result) && patchModelArray(result.result, true))
      changed = true;
    if (
      Array.isArray(result?.result?.data) &&
      patchModelArray(result.result.data, true)
    )
      changed = true;
    if (
      Array.isArray(result?.result?.models) &&
      patchModelArray(result.result.models, true)
    )
      changed = true;
    if (
      Array.isArray(result?.pages?.[0]?.data) &&
      patchModelArray(result.pages[0].data, true)
    )
      changed = true;
    if (
      Array.isArray(result?.message?.result?.data) &&
      patchModelArray(result.message.result.data, true)
    )
      changed = true;
    if (
      Array.isArray(result?.message?.result?.models) &&
      patchModelArray(result.message.result.models, true)
    )
      changed = true;
    if (patchModelContainer(result)) changed = true;
    return changed;
  };
  const patchAppServerResult = (method, result) => {
    if (!isModelListMethod(method)) return result;
    patchModelListResult(result);
    return result;
  };
  const rememberRequestClient = (client) => {
    if (!client || typeof client.sendRequest !== "function") return false;
    state.appServerClients = state.appServerClients || [];
    if (!state.appServerClients.includes(client))
      state.appServerClients.push(client);
    return true;
  };
  const patchRequestClient = (client) => {
    if (!rememberRequestClient(client)) return false;
    if (client.__ccSwitchModelRequestPatch === "3") return true;
    const original =
      typeof client.__ccSwitchOriginalSendRequest === "function"
        ? client.__ccSwitchOriginalSendRequest
        : client.sendRequest.bind(client);
    client.__ccSwitchOriginalSendRequest = original;
    client.sendRequest = async function ccSwitchPatchedSendRequest(
      method,
      params,
      options,
    ) {
      const actualMethod = appServerMethod(method, params);
      try {
        const result = await original(method, params, options);
        return patchAppServerResult(actualMethod, result);
      } catch (error) {
        if (!isGuardianV2FeatureTomlError(error)) throw error;
        const fallbackParams = guardianV2FallbackRequestParams(method, params);
        if (fallbackParams === params) throw error;
        state.guardianV2FallbackCount =
          (state.guardianV2FallbackCount || 0) + 1;
        const result = await original(method, fallbackParams, options);
        return patchAppServerResult(actualMethod, result);
      }
    };
    client.__ccSwitchModelRequestPatch = "3";
    return true;
  };
  const objectMethodNames = (object) => {
    const names = new Set();
    for (
      let current = object, level = 0;
      current && level < 4;
      level++, current = Object.getPrototypeOf(current)
    ) {
      for (const name of Object.getOwnPropertyNames(current)) names.add(name);
    }
    return names;
  };
  const isConversationRuntime = (candidate) => {
    if (
      !candidate ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    )
      return false;
    let names;
    try {
      names = objectMethodNames(candidate);
    } catch {
      return false;
    }
    return (
      names.has("sendRequest") &&
      names.has("getConversation") &&
      names.has("getStreamRole") &&
      names.has("waitForPendingThreadSettingsUpdate")
    );
  };
  const findConversationRuntime = () => {
    if (isConversationRuntime(state.conversationRuntime))
      return state.conversationRuntime;
    const seenFibers = new WeakSet();
    const seenValues = new WeakSet();
    const inspect = (value, depth = 0) => {
      if (
        !value ||
        (typeof value !== "object" && typeof value !== "function") ||
        seenValues.has(value)
      )
        return null;
      seenValues.add(value);
      if (isConversationRuntime(value)) return value;
      if (depth >= 3) return null;
      let descriptors;
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch {
        return null;
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (
          !("value" in descriptor) ||
          key === "return" ||
          key === "child" ||
          key === "sibling"
        )
          continue;
        const found = inspect(descriptor.value, depth + 1);
        if (found) return found;
      }
      return null;
    };
    for (const element of document.querySelectorAll("*")) {
      for (const key of reactFiberKeys(element)) {
        for (
          let fiber = element[key];
          fiber && !seenFibers.has(fiber);
          fiber = fiber.return
        ) {
          seenFibers.add(fiber);
          const roots = [
            fiber.updateQueue?.memoCache?.data,
            fiber.memoizedProps,
            fiber.memoizedState,
          ];
          for (const root of roots) {
            const found = inspect(root);
            if (!found) continue;
            state.conversationRuntime = found;
            return found;
          }
        }
      }
    }
    return null;
  };
  const installAppServerPatch = async () => {
    let discovered = rememberRequestClient(findConversationRuntime());
    try {
      const module = await loadAppModule("app-server-manager-signals-");
      for (const candidate of Object.values(module).filter(
        (item) => item && typeof item === "object",
      )) {
        if (patchRequestClient(candidate)) discovered = true;
        if (
          typeof candidate.sendRequest !== "function" &&
          typeof candidate.get === "function"
        ) {
          try {
            if (patchRequestClient(candidate.get())) discovered = true;
          } catch {}
        }
      }
    } catch (error) {
      state.failures.push(String(error?.message || error));
    }
    return discovered;
  };
  const runCompactAndRestartSession = async (threadId) => {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) throw new Error("A Codex thread id is required");
    await installAppServerPatch();
    const clients = [
      findConversationRuntime(),
      ...(state.appServerClients || []),
    ].filter(
      (client, index, array) =>
        client &&
        typeof client.sendRequest === "function" &&
        array.indexOf(client) === index,
    );
    if (!clients.length)
      throw new Error("Codex Desktop request client was not found");

    let lastError = null;
    for (const client of clients) {
      try {
        const before = await client.sendRequest("thread/read", {
          threadId: normalizedThreadId,
          includeTurns: true,
        });
        const beforeCompactions = countCompactionItems(before);
        await client.sendRequest("thread/compact/start", {
          threadId: normalizedThreadId,
        });

        const deadline = Date.now() + 90000;
        let compacted = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const current = await client.sendRequest("thread/read", {
            threadId: normalizedThreadId,
            includeTurns: true,
          });
          if (countCompactionItems(current) > beforeCompactions) {
            compacted = true;
            break;
          }
        }
        if (!compacted)
          throw new Error("Timed out waiting for native Codex compaction");

        const forked = await client.sendRequest("thread/fork", {
          threadId: normalizedThreadId,
          config: { model_reasoning_effort: "medium" },
        });
        const newThreadId = String(
          forked?.thread?.id ||
            forked?.threadId ||
            forked?.thread_id ||
            forked?.id ||
            "",
        ).trim();
        if (!newThreadId)
          throw new Error("Codex did not return the new session id");
        await triggerLocalThreadCatalogSync();
        state.lastRequestHealthRestart = {
          sourceThreadId: normalizedThreadId,
          newThreadId,
          completedAt: new Date().toISOString(),
        };
        return { completed: true, newThreadId };
      } catch (error) {
        lastError = error;
      }
    }
    throw (
      lastError ||
      new Error("Codex Desktop could not compact and restart the session")
    );
  };
  state.compactRestartJobs = state.compactRestartJobs || {};
  state.startCompactAndRestartSession = (threadId) => {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) throw new Error("A Codex thread id is required");
    const existing = Object.entries(state.compactRestartJobs).find(
      ([, job]) =>
        job?.threadId === normalizedThreadId && job?.status === "pending",
    );
    if (existing) return { started: true, jobId: existing[0] };

    const jobId = `${normalizedThreadId}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2)}`;
    state.compactRestartJobs[jobId] = {
      status: "pending",
      threadId: normalizedThreadId,
      startedAt: new Date().toISOString(),
    };
    void runCompactAndRestartSession(normalizedThreadId).then(
      (result) => {
        state.compactRestartJobs[jobId] = {
          ...state.compactRestartJobs[jobId],
          status: "completed",
          result,
          completedAt: new Date().toISOString(),
        };
      },
      (error) => {
        state.compactRestartJobs[jobId] = {
          ...state.compactRestartJobs[jobId],
          status: "failed",
          reason: String(error?.message || error),
          completedAt: new Date().toISOString(),
        };
      },
    );
    return { started: true, jobId };
  };
  state.readCompactRestartJob = (jobId) =>
    state.compactRestartJobs[String(jobId || "")] || null;
  const patchMcpModelResponseData = (data) => {
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    const requestId = message?.id != null ? String(message.id) : "";
    if (!requestId || !state.requestIds.has(requestId)) return false;
    state.requestIds.delete(requestId);
    return (
      patchModelListResult(message?.result) ||
      patchModelListResult(message?.result?.data)
    );
  };
  const installMessagePatch = () => {
    if (state.messagePatchInstalled) return;
    state.messagePatchInstalled = true;
    const originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = function ccSwitchPatchedDispatchEvent(event) {
      try {
        const detail = event?.detail;
        const request = detail?.request;
        if (
          event?.type === "codex-message-from-view" &&
          detail?.type === "mcp-request" &&
          request?.method === "model/list"
        ) {
          request.params = { ...(request.params || {}), includeHidden: true };
          if (request.id != null) state.requestIds.add(String(request.id));
        }
        if (event?.type === "message") patchMcpModelResponseData(event.data);
      } catch (error) {
        state.failures.push(String(error?.message || error));
      }
      return originalDispatchEvent.call(this, event);
    };
    window.addEventListener(
      "message",
      (event) => {
        try {
          patchMcpModelResponseData(event?.data);
        } catch (error) {
          state.failures.push(String(error?.message || error));
        }
      },
      true,
    );
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
      state.failures.push(String(error?.message || error));
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
    installMessagePatch();
    await installAppServerPatch();
    void triggerLocalThreadCatalogSync();
    patchStatsig();
    patchReactState();
    installModelPickerSpacingFix();
  };
  await run();
  if (!state.modelPickerObserver && typeof MutationObserver === "function") {
    state.modelPickerObserver = new MutationObserver(() =>
      installModelPickerSpacingFix(),
    );
    state.modelPickerObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  if (!state.interval)
    state.interval = setInterval(() => {
      void run();
    }, 1500);
  const historySync = await triggerLocalThreadCatalogSync();
  return {
    status: "ok",
    modelCount: modelNames().length,
    available_models: modelNames(),
    historySync,
    patchKey,
  };
})();
