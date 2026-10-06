import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Copy,
  FileText,
  KeyRound,
  Loader2,
  Play,
  PlugZap,
  RadioTower,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { proxyApi } from "@/lib/api/proxy";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  buildBaseUrl,
  buildReachableBaseUrl,
  buildJsonConfig,
  buildProfileUpdate,
  buildPythonSnippet,
  chooseDefaultBackendKey,
  describeBackendTarget,
  groupBackendOptions,
  profileBackendKey,
} from "@/lib/openai/externalProfile";
import {
  ExternalBackendPicker,
  SelectedBackendSummary,
} from "@/components/openai/ExternalBackendPicker";
import type { ExternalOpenAIAPIKey } from "@/types/proxy";

const BACKEND_STORAGE_KEY = "cc-switch-openai-compatible-backend";
const FALLBACK_MODEL = "gpt-5.4-mini";

type ApiTab = "source" | "access" | "config" | "check";

/// 读取用户上次在页面选择的服务来源 key。
function getSavedBackendKey(): string {
  return localStorage.getItem(BACKEND_STORAGE_KEY) ?? "";
}

/// 第三方 Agent OpenAI-compatible API 顶层工具页。
export function OpenAICompatibleApiPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ApiTab>("source");
  const [visibleApiKey, setVisibleApiKey] = useState("");
  const [selectedBackendKey, setSelectedBackendKey] =
    useState<string>(getSavedBackendKey);
  const [selectedModel, setSelectedModel] = useState("");
  const [isPreparing, setIsPreparing] = useState(false);
  const [listenAddress, setListenAddress] = useState("127.0.0.1");
  const [listenPort, setListenPort] = useState("15722");
  const [isSavingListener, setIsSavingListener] = useState(false);

  const {
    data: runtimeStatus,
    isLoading,
    refetch: refetchRuntimeStatus,
  } = useQuery({
    queryKey: ["externalOpenAIAPIRuntimeStatus"],
    queryFn: () => proxyApi.getExternalOpenAIAPIRuntimeStatus(),
  });

  const { data: externalApiStatus } = useQuery({
    queryKey: ["externalOpenAIAPIServerStatus"],
    queryFn: () => proxyApi.getExternalOpenAIAPIServerStatus(),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });

  const profile = runtimeStatus?.profile;
  const backendOptions = runtimeStatus?.backendOptions ?? [];
  const savedBackendKey = profileBackendKey(profile);
  const selectedKey = chooseDefaultBackendKey(backendOptions, [
    selectedBackendKey,
    savedBackendKey,
    runtimeStatus?.selectedBackend?.key,
  ]);
  const selectedBackend =
    backendOptions.find((option) => option.key === selectedKey) ??
    runtimeStatus?.selectedBackend ??
    null;
  const availableModels = selectedBackend?.models ?? [];
  const defaultModel =
    selectedModel ||
    (profile?.defaultModel && availableModels.includes(profile.defaultModel)
      ? profile.defaultModel
      : "") ||
    runtimeStatus?.effectiveModel ||
    availableModels[0] ||
    profile?.defaultModel ||
    FALLBACK_MODEL;
  const isRunning = externalApiStatus?.running === true;
  const effectiveAddress =
    externalApiStatus?.address || profile?.listenAddress || listenAddress;
  const effectivePort =
    externalApiStatus?.port ||
    profile?.listenPort ||
    Number(listenPort) ||
    15722;
  const baseUrl = buildBaseUrl(effectiveAddress, effectivePort);
  const reachableBaseUrl = buildReachableBaseUrl(
    effectiveAddress,
    effectivePort,
  );
  const agentBaseUrl = reachableBaseUrl;
  const apiKeys = profile?.apiKeys ?? [];
  const latestCopyableApiKey =
    [...apiKeys].reverse().find((key) => key.apiKey)?.apiKey ?? "";
  const displayApiKey =
    latestCopyableApiKey ||
    visibleApiKey ||
    (profile?.hasApiKey
      ? `${profile.apiKeyPrefix ?? "ccsw_"}...`
      : "Not generated yet");
  const runnableApiKey =
    latestCopyableApiKey || visibleApiKey || "<generate-key-to-reveal>";
  const statusIssues = runtimeStatus?.issues ?? [];
  const backendGroups = useMemo(
    () => groupBackendOptions(backendOptions, t),
    [backendOptions, t],
  );
  const selectedBackendDescription = describeBackendTarget(selectedBackend, t);
  const hasDraftChanges =
    selectedBackend?.key !== savedBackendKey ||
    (profile?.defaultModel ?? "") !== defaultModel;
  const canSaveSelected = Boolean(selectedBackend?.available);

  useEffect(() => {
    if (!selectedBackendKey && selectedKey) {
      setSelectedBackendKey(selectedKey);
    }
  }, [selectedBackendKey, selectedKey]);

  useEffect(() => {
    if (!profile) return;
    setListenAddress(profile.listenAddress || "127.0.0.1");
    setListenPort(String(profile.listenPort || 15722));
  }, [profile]);

  /// 复制普通配置文本并给出反馈。
  async function handleCopy(text: string, label: string) {
    await copyText(text);
    toast.success(`${label} copied`, { closeButton: true });
  }

  /// 新增本地 External API key；新格式 key 会随 profile 返回，后续仍可复制。
  async function handleRegenerateKey() {
    const result = await proxyApi.regenerateExternalOpenAIAPIKey();
    setVisibleApiKey(result.apiKey);
    await queryClient.invalidateQueries({
      queryKey: ["externalOpenAIAPIRuntimeStatus"],
    });
    toast.success("External API key added", { closeButton: true });
    setActiveTab("config");
  }

  /// 删除指定的本地 External API key；不会影响上游 provider 凭据。
  async function handleDeleteKey(keyId: string, apiKey?: string | null) {
    await proxyApi.deleteExternalOpenAIAPIKey(keyId);
    if (apiKey && visibleApiKey === apiKey) {
      setVisibleApiKey("");
    }
    await queryClient.invalidateQueries({
      queryKey: ["externalOpenAIAPIRuntimeStatus"],
    });
    toast.success("Local API key deleted", { closeButton: true });
  }

  /// 保存第三方 Agent API 的独立监听地址和端口；不修改全局 proxy_config 或 app takeover。
  async function handleSaveListenerConfig() {
    const parsedPort = Number(listenPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      toast.error("Port must be an integer from 1 to 65535");
      return;
    }
    if (!selectedBackend) {
      toast.error("Select a service source first");
      return;
    }

    setIsSavingListener(true);
    try {
      const update = buildProfileUpdate(
        selectedBackend,
        defaultModel,
        profile?.enabled ?? false,
        listenAddress.trim() || "127.0.0.1",
        parsedPort,
      );
      await proxyApi.updateExternalOpenAIAPIProfile(update);
      await queryClient.invalidateQueries({
        queryKey: ["externalOpenAIAPIRuntimeStatus"],
      });
      toast.success(
        isRunning
          ? "Listener configuration saved; restart the third-party Agent API to apply it"
          : "Listener configuration saved",
        { closeButton: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to save listener configuration: ${message}`);
    } finally {
      setIsSavingListener(false);
    }
  }

  /// 复制含 API key 的片段；没有明文 key 时拒绝复制占位配置。
  async function handleCopyRunnableConfig(value: string, label: string) {
    if (!latestCopyableApiKey && !visibleApiKey) {
      toast.error("Generate a local API key before copying it");
      setActiveTab("access");
      return;
    }
    await handleCopy(value, label);
  }

  /// 更新页面选中的服务来源，并清空模型临时选择。
  function handleBackendChange(value: string) {
    setSelectedBackendKey(value);
    localStorage.setItem(BACKEND_STORAGE_KEY, value);
    setSelectedModel("");
  }

  /// 保存当前服务来源 profile，但不启动 proxy server。
  async function handleSaveProfile(enabled = profile?.enabled ?? false) {
    if (!selectedBackend) {
      toast.error("Select a service source first");
      return;
    }
    if (!selectedBackend.available) {
      toast.error(
        selectedBackend.error ??
          "The selected service source is not ready for integration",
      );
      return;
    }

    try {
      const parsedPort = Number(listenPort);
      const update = buildProfileUpdate(
        selectedBackend,
        defaultModel,
        enabled,
        listenAddress.trim() || "127.0.0.1",
        Number.isInteger(parsedPort) ? parsedPort : 15722,
      );
      await proxyApi.updateExternalOpenAIAPIProfile(update);
      await queryClient.invalidateQueries({
        queryKey: ["externalOpenAIAPIRuntimeStatus"],
      });
      toast.success("Third-party Agent API configuration saved", {
        closeButton: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Save failed: ${message}`);
    }
  }

  /// 保存 profile、必要时生成 key，并启动本地 proxy server。
  async function handlePrepareService() {
    if (!selectedBackend) {
      toast.error("Select a service source first");
      return;
    }
    if (!selectedBackend.available) {
      toast.error(
        selectedBackend.error ??
          "The selected service source is not ready for integration",
      );
      return;
    }

    setIsPreparing(true);
    try {
      if (!visibleApiKey && !profile?.hasApiKey) {
        const result = await proxyApi.regenerateExternalOpenAIAPIKey();
        setVisibleApiKey(result.apiKey);
      }
      const parsedPort = Number(listenPort);
      const update = buildProfileUpdate(
        selectedBackend,
        defaultModel,
        true,
        listenAddress.trim() || "127.0.0.1",
        Number.isInteger(parsedPort) ? parsedPort : 15722,
      );
      await proxyApi.updateExternalOpenAIAPIProfile(update);
      if (!isRunning) await proxyApi.startExternalOpenAIAPIServer();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["externalOpenAIAPIServerStatus"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["externalOpenAIAPIRuntimeStatus"],
        }),
      ]);
      toast.success("Third-party Agent API enabled", { closeButton: true });
      setActiveTab("config");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Preparation failed: ${message}`);
    } finally {
      setIsPreparing(false);
    }
  }

  /// 刷新 proxy 状态和 External API runtime 状态。
  async function handleRefresh() {
    await Promise.all([
      refetchRuntimeStatus(),
      queryClient.invalidateQueries({
        queryKey: ["externalOpenAIAPIServerStatus"],
      }),
    ]);
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden px-6 py-4">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2">
        <ApiHero
          isRunning={isRunning}
          profileEnabled={profile?.enabled === true}
          ready={runtimeStatus?.ready === true}
          baseUrl={baseUrl}
          selectedLabel={selectedBackend?.label ?? "No service source selected"}
          onPrepare={() => void handlePrepareService()}
          onRefresh={() => void handleRefresh()}
          isPreparing={isPreparing}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as ApiTab)}
        >
          <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur">
            <TabsList className="grid w-full grid-cols-4 bg-muted p-1 dark:bg-slate-950/40">
              <ApiTabTrigger
                value="source"
                icon={PlugZap}
                label="Service source"
              />
              <ApiTabTrigger
                value="access"
                icon={KeyRound}
                label="Access credentials"
              />
              <ApiTabTrigger
                value="config"
                icon={FileText}
                label="Agent configuration"
              />
              <ApiTabTrigger value="check" icon={ShieldCheck} label="Checks" />
            </TabsList>
          </div>

          <TabsContent value="source" className="mt-3">
            <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
              <section className="rounded-lg border border-blue-700/40 bg-blue-950/10 p-4">
                <SectionHeader
                  icon={PlugZap}
                  title="Choose the external service source"
                  detail="Third-party agents only see the OpenAI v1 API; choose which internal model source CC Switch uses here."
                />
                <div className="mt-4">
                  <ExternalBackendPicker
                    groups={backendGroups}
                    selectedKey={selectedBackend?.key ?? ""}
                    onSelect={handleBackendChange}
                  />
                </div>
              </section>

              <aside className="space-y-3">
                <SelectedBackendSummary
                  backend={selectedBackend ?? undefined}
                  description={selectedBackendDescription}
                  hasDraftChanges={hasDraftChanges}
                />
                <ModelPicker
                  availableModels={availableModels}
                  defaultModel={defaultModel}
                  selectedModel={selectedModel}
                  onModelChange={setSelectedModel}
                />
                <Button
                  onClick={() =>
                    void handleSaveProfile(profile?.enabled ?? false)
                  }
                  disabled={!canSaveSelected || !hasDraftChanges}
                  className="w-full gap-2 bg-blue-600 hover:bg-blue-500"
                >
                  <Settings2 className="h-4 w-4" />
                  Save source and model
                </Button>
              </aside>
            </div>
          </TabsContent>

          <TabsContent value="access" className="mt-3">
            <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
              <section className="rounded-lg border border-emerald-700/40 bg-emerald-950/10 p-4">
                <SectionHeader
                  icon={KeyRound}
                  title="Local access credentials"
                  detail="This key protects only the local API; it is not an upstream OpenAI or ChatGPT credential."
                />
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <ConfigValue
                    label="base_url"
                    value={baseUrl}
                    tone="emerald"
                    onCopy={() => handleCopy(baseUrl, "base_url")}
                  />
                  <ConfigValue
                    label="api_key"
                    value={displayApiKey}
                    tone="amber"
                    onCopy={() =>
                      latestCopyableApiKey || visibleApiKey
                        ? handleCopy(
                            latestCopyableApiKey || visibleApiKey,
                            "api_key",
                          )
                        : toast.error(
                            "Generate a local API key before copying it",
                          )
                    }
                  />
                </div>
                <ApiKeyList
                  keys={apiKeys}
                  onCopy={(apiKey) => void handleCopy(apiKey, "api_key")}
                  onDelete={(keyId, apiKey) =>
                    void handleDeleteKey(keyId, apiKey)
                  }
                />
                <ListenerSettings
                  listenAddress={listenAddress}
                  listenPort={listenPort}
                  baseUrl={baseUrl}
                  reachableBaseUrl={reachableBaseUrl}
                  isRunning={isRunning}
                  isSaving={isSavingListener}
                  onAddressChange={setListenAddress}
                  onPortChange={setListenPort}
                  onSave={() => void handleSaveListenerConfig()}
                />
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={handleRegenerateKey}
                    className="gap-2 bg-emerald-600 hover:bg-emerald-500"
                  >
                    <KeyRound className="h-4 w-4" />
                    Generate new ccsw_ key
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handlePrepareService()}
                    disabled={isPreparing || !canSaveSelected}
                    className="gap-2"
                  >
                    {isPreparing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    Save and start API
                  </Button>
                </div>
              </section>

              <SecurityPanel />
            </div>
          </TabsContent>

          <TabsContent value="config" className="mt-3">
            <div className="grid gap-4 lg:grid-cols-2">
              <SnippetPanel
                title="Agent JSON configuration"
                value={buildJsonConfig(
                  agentBaseUrl,
                  runnableApiKey,
                  defaultModel,
                )}
                onCopy={() =>
                  handleCopyRunnableConfig(
                    buildJsonConfig(agentBaseUrl, runnableApiKey, defaultModel),
                    "Agent JSON configuration",
                  )
                }
              />
              <SnippetPanel
                title="OpenAI Python SDK example"
                value={buildPythonSnippet(
                  agentBaseUrl,
                  runnableApiKey,
                  defaultModel,
                )}
                onCopy={() =>
                  handleCopyRunnableConfig(
                    buildPythonSnippet(
                      agentBaseUrl,
                      runnableApiKey,
                      defaultModel,
                    ),
                    "Python example",
                  )
                }
              />
            </div>
          </TabsContent>

          <TabsContent value="check" className="mt-3">
            <CheckTab
              isRunning={isRunning}
              profileEnabled={profile?.enabled === true}
              hasApiKey={profile?.hasApiKey === true || Boolean(visibleApiKey)}
              hasBackend={Boolean(selectedBackend)}
              backendAvailable={selectedBackend?.available === true}
              model={defaultModel}
              issues={statusIssues}
              onRefresh={() => void handleRefresh()}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/// 顶部状态区，使用多色状态块说明当前 API 是否可以被第三方 agent 接入。
function ApiHero({
  isRunning,
  profileEnabled,
  ready,
  baseUrl,
  selectedLabel,
  onPrepare,
  onRefresh,
  isPreparing,
}: {
  isRunning: boolean;
  profileEnabled: boolean;
  ready: boolean;
  baseUrl: string;
  selectedLabel: string;
  onPrepare: () => void;
  onRefresh: () => void;
  isPreparing: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card dark:border-slate-700/80 dark:bg-slate-950/30">
      <div className="grid gap-4 border-b border-border bg-gradient-to-r from-emerald-50 via-background to-blue-50 p-5 xl:grid-cols-[1fr_auto] dark:border-slate-700/70 dark:from-emerald-950/50 dark:via-slate-900 dark:to-blue-950/50">
        <div>
          <div className="flex items-center gap-2 text-xl font-semibold">
            <RadioTower className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
            Third-party Agent API
          </div>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground dark:text-slate-300">
            Exposes a fixed OpenAI v1-compatible API. Third-party agents only
            need to provide base_url, api_key, and model; OAuth, upstream
            credentials, and routing details stay inside CC Switch.
          </p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <Button
            onClick={onPrepare}
            disabled={isPreparing}
            className="gap-2 bg-emerald-600 hover:bg-emerald-500"
          >
            {isPreparing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Save and start
          </Button>
          <Button variant="outline" onClick={onRefresh} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>
      <div className="grid gap-3 p-4 md:grid-cols-4">
        <HeroMetric
          color="emerald"
          icon={Server}
          label="API endpoint"
          value={isRunning ? "Running" : "Stopped"}
          detail={baseUrl}
        />
        <HeroMetric
          color="blue"
          icon={PlugZap}
          label="Service source"
          value={selectedLabel}
          detail="Choose below"
        />
        <HeroMetric
          color="amber"
          icon={KeyRound}
          label="Access status"
          value={profileEnabled ? "Enabled" : "Disabled"}
          detail="Uses a local ccsw_ key"
        />
        <HeroMetric
          color={ready ? "emerald" : "rose"}
          icon={ready ? CheckCircle2 : AlertCircle}
          label="Integration checks"
          value={ready ? "Ready" : "Needs configuration"}
          detail="Does not switch the current Codex model source"
        />
      </div>
    </div>
  );
}

/// 选项卡触发器封装，统一图标和可点击态。
function ApiTabTrigger({
  value,
  icon: Icon,
  label,
}: {
  value: ApiTab;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <TabsTrigger value={value} className="min-w-0 gap-2">
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{label}</span>
    </TabsTrigger>
  );
}

/// 模型选择区；当后端没有枚举模型时允许用户手填默认模型。
function ModelPicker({
  availableModels,
  defaultModel,
  selectedModel,
  onModelChange,
}: {
  availableModels: string[];
  defaultModel: string;
  selectedModel: string;
  onModelChange: (value: string) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-700/40 dark:bg-amber-950/10">
      <div className="mb-2 text-sm font-semibold text-foreground dark:text-slate-100">
        Default model
      </div>
      {availableModels.length > 0 ? (
        <Select value={defaultModel} onValueChange={onModelChange}>
          <SelectTrigger className="border-amber-200 bg-background dark:border-amber-700/40 dark:bg-slate-950/60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableModels.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <input
          value={selectedModel || defaultModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="h-10 w-full rounded-md border border-amber-200 bg-background px-3 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-500/20 dark:border-amber-700/40 dark:bg-slate-950/60"
        />
      )}
      <p className="mt-2 text-xs leading-5 text-muted-foreground dark:text-slate-400">
        Third-party agent requests may also provide model explicitly; this is
        the default used by the examples.
      </p>
    </div>
  );
}

/// 监听配置区：控制第三方 Agent API 绑定到哪个地址和端口。
/// 本地 sidecar API key 列表；新格式 key 可重复复制，旧 hash-only key 只能删除。
function ApiKeyList({
  keys,
  onCopy,
  onDelete,
}: {
  keys: ExternalOpenAIAPIKey[];
  onCopy: (apiKey: string) => void;
  onDelete: (keyId: string, apiKey?: string | null) => void;
}) {
  return (
    <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-700/40 dark:bg-slate-950/30">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-100">
          Available keys
        </div>
        <Badge variant="outline">{keys.length}</Badge>
      </div>
      {keys.length === 0 ? (
        <div className="rounded-md border border-dashed border-emerald-200 px-3 py-4 text-sm text-muted-foreground dark:border-emerald-700/40 dark:text-slate-400">
          No local API key has been generated.
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-background/70 px-3 py-2 dark:border-emerald-900/60 dark:bg-black/20"
            >
              <code className="min-w-0 flex-1 truncate text-xs text-foreground dark:text-slate-100">
                {key.apiKey ?? `${key.prefix}...`}
              </code>
              {key.legacy ? (
                <Badge
                  variant="outline"
                  className="border-amber-600/50 text-amber-200"
                >
                  Legacy
                </Badge>
              ) : null}
              <span className="text-xs text-muted-foreground dark:text-slate-500">
                {formatKeyCreatedAt(key.createdAt)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                disabled={!key.apiKey}
                onClick={() => key.apiKey && onCopy(key.apiKey)}
                title={
                  key.apiKey ? "Copy key" : "Legacy key plaintext was not saved"
                }
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(key.id, key.apiKey)}
                title="Delete key"
              >
                <Trash2 className="h-4 w-4 text-rose-300" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// 将 Unix 秒级时间戳格式化为紧凑的本地时间；0 表示旧数据没有创建时间。
function formatKeyCreatedAt(createdAt: number): string {
  if (!createdAt) return "Unknown time";
  return new Date(createdAt * 1000).toLocaleString();
}

function ListenerSettings({
  listenAddress,
  listenPort,
  baseUrl,
  reachableBaseUrl,
  isRunning,
  isSaving,
  onAddressChange,
  onPortChange,
  onSave,
}: {
  listenAddress: string;
  listenPort: string;
  baseUrl: string;
  reachableBaseUrl: string;
  isRunning: boolean;
  isSaving: boolean;
  onAddressChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onSave: () => void;
}) {
  const isPublicBind = listenAddress === "0.0.0.0" || listenAddress === "::";

  return (
    <div className="mt-4 rounded-lg border border-cyan-200 bg-cyan-50/70 p-4 dark:border-cyan-700/40 dark:bg-cyan-950/10">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-cyan-800 dark:text-cyan-100">
            <RadioTower className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />
            Listener address and port
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground dark:text-slate-400">
            Local access is allowed by default. To allow LAN or public agents,
            bind to all interfaces or a specific network address.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={onSave}
          disabled={isSaving}
          className="gap-2 border-cyan-600/50"
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Settings2 className="h-4 w-4" />
          )}
          Save listener
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-[220px_140px_1fr]">
        <Select value={listenAddress} onValueChange={onAddressChange}>
          <SelectTrigger className="border-cyan-200 bg-background dark:border-cyan-700/40 dark:bg-slate-950/60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="127.0.0.1">Local only 127.0.0.1</SelectItem>
            <SelectItem value="0.0.0.0">All interfaces 0.0.0.0</SelectItem>
            <SelectItem value="localhost">localhost</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={listenPort}
          onChange={(event) => onPortChange(event.target.value)}
          inputMode="numeric"
          placeholder="15722"
          className="border-cyan-200 bg-background dark:border-cyan-700/40 dark:bg-slate-950/60"
        />
        <Input
          value={listenAddress}
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder="Custom address, for example 192.168.1.20"
          className="border-cyan-200 bg-background dark:border-cyan-700/40 dark:bg-slate-950/60"
        />
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <code className="rounded-md border border-cyan-200 bg-background/70 px-3 py-2 text-xs text-cyan-800 dark:border-cyan-700/30 dark:bg-black/20 dark:text-cyan-100">
          Local: {baseUrl}
        </code>
        <code className="rounded-md border border-cyan-200 bg-background/70 px-3 py-2 text-xs text-cyan-800 dark:border-cyan-700/30 dark:bg-black/20 dark:text-cyan-100">
          External agent: {reachableBaseUrl}
        </code>
      </div>
      {isPublicBind && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          Binding all interfaces lets clients on the LAN or public network
          access this API. Use a firewall, a strong random ccsw_ key, and a
          trusted network.
        </div>
      )}
      {isRunning && (
        <div className="mt-2 text-xs text-muted-foreground dark:text-slate-400">
          After changing the listener address or port while running, stop and
          restart the local API to bind the new address.
        </div>
      )}
    </div>
  );
}

/// 安全说明区，强调 Key 和 OAuth 的隔离边界。
function SecurityPanel() {
  return (
    <section className="rounded-lg border border-blue-700/40 bg-blue-950/10 p-4">
      <SectionHeader
        icon={ShieldCheck}
        title="Isolation boundaries"
        detail="This page manages only the third-party Agent API profile."
      />
      <div className="mt-4 space-y-2">
        <BoundaryItem
          ok
          text="Does not expose OAuth tokens, refresh tokens, or real upstream API keys"
        />
        <BoundaryItem
          ok
          text="Does not switch the current Codex model source or enable takeover"
        />
        <BoundaryItem
          ok
          text="Only stores and displays the local CCSwitchMulti ccsw_ key"
        />
        <BoundaryItem
          ok
          text="Native Claude/Gemini protocols are not silently masqueraded as OpenAI API"
        />
      </div>
    </section>
  );
}

/// 检查页展示缺什么，而不是只给出一串英文 issue。
function CheckTab({
  isRunning,
  profileEnabled,
  hasApiKey,
  hasBackend,
  backendAvailable,
  model,
  issues,
  onRefresh,
}: {
  isRunning: boolean;
  profileEnabled: boolean;
  hasApiKey: boolean;
  hasBackend: boolean;
  backendAvailable: boolean;
  model: string;
  issues: string[];
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 dark:border-slate-700 dark:bg-slate-950/40">
      <SectionHeader
        icon={ShieldCheck}
        title="Integration checks"
        detail="External agents can reliably use /v1/chat/completions after these checks pass."
        action={
          <Button variant="outline" onClick={onRefresh} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Check again
          </Button>
        }
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ChecklistItem ok={isRunning} label="Local API service is running" />
        <ChecklistItem
          ok={profileEnabled}
          label="Third-party Agent API profile Enabled"
        />
        <ChecklistItem
          ok={hasApiKey}
          label="A local ccsw_ access key was generated"
        />
        <ChecklistItem
          ok={hasBackend && backendAvailable}
          label="An integration-ready service source is selected"
        />
        <ChecklistItem
          ok={Boolean(model)}
          label={`Default model: ${model || "Not selected"}`}
        />
        <ChecklistItem ok label="Codex itself is unaffected" />
      </div>
      {issues.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="mb-2 text-sm font-semibold text-amber-100">
            Current issues
          </div>
          <div className="flex flex-wrap gap-2">
            {issues.map((issue) => (
              <Badge key={issue} variant="outline">
                {translateIssue(issue)}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/// 顶部彩色指标卡。
function HeroMetric({
  color,
  icon: Icon,
  label,
  value,
  detail,
}: {
  color: "emerald" | "blue" | "amber" | "rose";
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
}) {
  const styles = {
    emerald:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200",
    blue: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200",
    amber:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
    rose: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200",
  }[color];

  return (
    <div className={cn("min-w-0 rounded-lg border p-3", styles)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs opacity-80">{label}</span>
        <Icon className="h-4 w-4 opacity-80" />
      </div>
      <div className="mt-2 truncate text-lg font-semibold text-foreground dark:text-white">
        {value}
      </div>
      <div className="mt-1 truncate text-xs opacity-75">{detail}</div>
    </div>
  );
}

/// 通用标题行。
function SectionHeader({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-base font-semibold text-foreground dark:text-slate-100">
          <Icon className="h-4 w-4 text-blue-600 dark:text-blue-300" />
          {title}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground dark:text-slate-400">
          {detail}
        </p>
      </div>
      {action}
    </div>
  );
}

/// 渲染可复制的配置字段。
function ConfigValue({
  label,
  value,
  tone,
  onCopy,
}: {
  label: string;
  value: string;
  tone: "emerald" | "amber";
  onCopy: () => void;
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-700/40 dark:bg-emerald-950/20"
      : "border-amber-200 bg-amber-50/70 dark:border-amber-700/40 dark:bg-amber-950/20";
  return (
    <div className={cn("min-w-0 rounded-lg border p-3", toneClass)}>
      <div className="mb-2 text-xs font-medium uppercase text-muted-foreground dark:text-slate-400">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-sm text-foreground dark:text-slate-100">
          {value}
        </code>
        <Button
          variant="ghost"
          size="icon"
          onClick={onCopy}
          title={`Copy ${label}`}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/// 渲染可复制的代码片段。
function SnippetPanel({
  title,
  value,
  onCopy,
}: {
  title: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 dark:border-slate-700 dark:bg-slate-950/40">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground dark:text-slate-100">
          <Clipboard className="h-4 w-4 text-blue-600 dark:text-blue-300" />
          {title}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onCopy}
          title={`Copy ${title}`}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed text-foreground dark:bg-black/30 dark:text-slate-100">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function BoundaryItem({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50/70 p-2 text-sm text-foreground dark:border-blue-700/30 dark:bg-slate-950/40 dark:text-slate-200">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-300" />
      ) : (
        <AlertCircle className="h-4 w-4 text-amber-300" />
      )}
      {text}
    </div>
  );
}

function ChecklistItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border p-3 text-sm",
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
          : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      )}
    >
      {ok ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <AlertCircle className="h-4 w-4" />
      )}
      {label}
    </div>
  );
}

function translateIssue(issue: string): string {
  const translations: Record<string, string> = {
    "profile disabled": "Profile is not enabled",
    "api key not generated": "No ccsw_ key has been generated",
    "backend not selected": "No service source selected",
    "model not selected": "No default model selected",
  };
  return translations[issue] ?? issue;
}
