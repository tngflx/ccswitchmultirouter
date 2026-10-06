/**
 * TE Provider 专用面板：编辑非秘密的绑定设置与模型能力元数据。
 *
 * 设计边界：
 * - 这里只写静态字段。Proxy Key、Agent Credential、task/lease/session/binding 由运行时注入，
 *   面板只展示它们「由谁填写、是否落盘」，绝不提供输入框。
 * - 模型能力缺失表示「未知」，不等于「不支持」；面板允许留空，并在校验失败时给出确定性错误码。
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  OpenClawTeBindingDelivery,
  OpenClawTeProviderModel,
  OpenClawTeProviderSettings,
} from "@/types";
import {
  TE_PROVIDER_BINDING_FIELDS,
  TE_PROVIDER_DEFAULT_KEEP_ALIVE_SECONDS,
  TE_PROVIDER_DEFAULT_TIMEOUT_SECONDS,
  validateTeProviderSettings,
} from "@/utils/teProvider";
import {
  getTeProviderRuntimeStatus,
  type TeProviderRuntimeStatus,
} from "@/lib/api/teProvider";

const INPUT_MODALITIES = ["text", "image", "audio", "video", "file"] as const;
const OUTPUT_MODALITIES = ["text", "embedding", "audio", "image"] as const;
const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

/** 校验错误码 → 中文说明；未登记的错误码原样显示，便于排查而不是静默吞掉。 */
const ERROR_LABELS: Record<string, string> = {
  te_provider_settings_required: "TE Provider settings object is missing",
  te_provider_sidecar_url_required: "The local injection endpoint is required",
  te_provider_sidecar_url_must_be_loopback:
    "The injection endpoint must use a numeric loopback URL: http://127.0.0.1 or http://[::1]",
  te_provider_expected_aic_required:
    "The Partner AIC for this host service is required",
  te_provider_expected_aic_invalid:
    "Partner AIC contains invalid characters or is too long",
  te_provider_protocol_version_invalid:
    "Protocol version must be te-provider.v1",
  te_provider_binding_delivery_invalid:
    "Binding delivery must be a config header or Gateway plugin",
  te_provider_probe_url_must_be_loopback:
    "The keep-alive probe URL must use a numeric loopback address",
  te_provider_timeout_invalid:
    "Provider timeout must be an integer of at least 30 seconds",
  te_provider_keep_alive_invalid:
    "Keep-alive interval must be an integer of at least 5 seconds",
  te_provider_models_required: "At least one model entry is required",
  te_provider_runtime_field_forbidden:
    "Runtime binding fields cannot be written to static configuration",
  te_provider_secret_field_forbidden:
    "Proxy Key or Agent Credential cannot be written to static configuration",
  te_provider_unknown_field_forbidden:
    "Configuration contains a field that is not allowed",
};

function errorLabel(code: string): string {
  if (ERROR_LABELS[code]) return ERROR_LABELS[code];
  if (code.includes("_id_required")) return "Model ID cannot be empty";
  if (code.includes("_id_duplicated")) return "Model IDs must be unique";
  if (code.includes("_name_required"))
    return "Model display name cannot be empty";
  if (code.includes("_input_invalid"))
    return "Input modality must be text/image/audio/video/file";
  if (code.includes("_output_invalid"))
    return "Output modality must be text/embedding/audio/image";
  if (code.includes("_reasoning_invalid"))
    return "Invalid reasoning effort value";
  if (code.includes("_contextWindowTokens_invalid"))
    return "Context length must be a positive integer";
  if (code.includes("_maxOutputTokens_invalid"))
    return "Maximum output length must be a positive integer";
  return code;
}

export interface TeProviderFieldsProps {
  value: OpenClawTeProviderSettings;
  onChange: (next: OpenClawTeProviderSettings) => void;
}

export function TeProviderFields({ value, onChange }: TeProviderFieldsProps) {
  const { t } = useTranslation();
  const errors = useMemo(() => validateTeProviderSettings(value), [value]);
  const runtimeFields = TE_PROVIDER_BINDING_FIELDS.filter(
    (field) => !field.persisted,
  );
  const [runtimeStatus, setRuntimeStatus] =
    useState<TeProviderRuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  /**
   * 读取运行态只做只读探针：失败时把稳定错误显示出来，不把失败伪装成「未运行」，
   * 也不因为探针失败改动任何保存中的设置。
   */
  const refreshRuntimeStatus = useCallback(async () => {
    setRuntimeBusy(true);
    setRuntimeError("");
    try {
      const status = await getTeProviderRuntimeStatus(value.sidecarUrl);
      setRuntimeStatus(status);
    } catch (error) {
      setRuntimeStatus(null);
      setRuntimeError(
        error instanceof Error
          ? error.message
          : "Failed to read runtime status",
      );
    } finally {
      setRuntimeBusy(false);
    }
  }, [value.sidecarUrl]);

  function providerStatusText(status: TeProviderRuntimeStatus): string {
    if (!status.provider) return "The upstream probe returned no result";
    if (status.provider.online === true) return "Upstream online";
    if (status.provider.online === false) return "Upstream offline";
    return `Upstream status unknown (${status.provider.reason ?? "provider_probe_not_configured"})`;
  }

  function update(patch: Partial<OpenClawTeProviderSettings>) {
    // 显式重建静态字段，避免把未来新增的 runtime/secret 字段复制回草稿。
    onChange({
      sidecarUrl:
        patch.sidecarUrl !== undefined ? patch.sidecarUrl : value.sidecarUrl,
      expectedPartnerAic:
        patch.expectedPartnerAic !== undefined
          ? patch.expectedPartnerAic
          : value.expectedPartnerAic,
      protocolVersion:
        patch.protocolVersion !== undefined
          ? patch.protocolVersion
          : value.protocolVersion,
      bindingDelivery:
        patch.bindingDelivery !== undefined
          ? patch.bindingDelivery
          : value.bindingDelivery,
      providerTimeoutSeconds: Object.prototype.hasOwnProperty.call(
        patch,
        "providerTimeoutSeconds",
      )
        ? patch.providerTimeoutSeconds
        : value.providerTimeoutSeconds,
      keepAliveIntervalSeconds: Object.prototype.hasOwnProperty.call(
        patch,
        "keepAliveIntervalSeconds",
      )
        ? patch.keepAliveIntervalSeconds
        : value.keepAliveIntervalSeconds,
      models: patch.models !== undefined ? patch.models : value.models,
    });
  }

  function updateModel(index: number, patch: Partial<OpenClawTeProviderModel>) {
    const models = value.models.map((model, current) => {
      if (current !== index) return model;
      return {
        id: patch.id ?? model.id,
        name: patch.name ?? model.name,
        inputModalities: Object.prototype.hasOwnProperty.call(
          patch,
          "inputModalities",
        )
          ? patch.inputModalities
          : model.inputModalities,
        outputModalities: Object.prototype.hasOwnProperty.call(
          patch,
          "outputModalities",
        )
          ? patch.outputModalities
          : model.outputModalities,
        contextWindowTokens: Object.prototype.hasOwnProperty.call(
          patch,
          "contextWindowTokens",
        )
          ? patch.contextWindowTokens
          : model.contextWindowTokens,
        maxOutputTokens: Object.prototype.hasOwnProperty.call(
          patch,
          "maxOutputTokens",
        )
          ? patch.maxOutputTokens
          : model.maxOutputTokens,
        supportsTools: Object.prototype.hasOwnProperty.call(
          patch,
          "supportsTools",
        )
          ? patch.supportsTools
          : model.supportsTools,
        supportsReasoning: Object.prototype.hasOwnProperty.call(
          patch,
          "supportsReasoning",
        )
          ? patch.supportsReasoning
          : model.supportsReasoning,
        reasoningEfforts: Object.prototype.hasOwnProperty.call(
          patch,
          "reasoningEfforts",
        )
          ? patch.reasoningEfforts
          : model.reasoningEfforts,
        cost: Object.prototype.hasOwnProperty.call(patch, "cost")
          ? patch.cost
          : model.cost,
      };
    });
    update({ models });
  }

  function toggleList(
    current: string[] | undefined,
    item: string,
    checked: boolean,
  ): string[] {
    const next = new Set(current ?? []);
    if (checked) next.add(item);
    else next.delete(item);
    return Array.from(next);
  }

  function numberOrUndefined(raw: string): number | undefined {
    if (!raw.trim()) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return (
    <div className="space-y-6" data-testid="te-provider-fields">
      <div className="rounded-lg border p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium">
            {t("openclaw.teProvider.bindings", {
              defaultValue: "TE binding settings (static, no secrets)",
            })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("openclaw.teProvider.bindingsHint", {
              defaultValue:
                "Only the local injection endpoint and capability metadata are saved here; Proxy Key and Agent Credential are always injected at runtime and never enter configuration.",
            })}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="te-sidecar-url">
              {t("openclaw.teProvider.sidecarUrl", {
                defaultValue: "Injection endpoint",
              })}
            </Label>
            <Input
              id="te-sidecar-url"
              data-testid="te-sidecar-url"
              value={value.sidecarUrl}
              onChange={(event) => update({ sidecarUrl: event.target.value })}
              placeholder="http://127.0.0.1:9814"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="te-partner-aic">
              {t("openclaw.teProvider.expectedPartnerAic", {
                defaultValue: "Partner AIC for this host",
              })}
            </Label>
            <Input
              id="te-partner-aic"
              data-testid="te-expected-partner-aic"
              value={value.expectedPartnerAic}
              onChange={(event) =>
                update({ expectedPartnerAic: event.target.value })
              }
              placeholder="1.2.156.3088...."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="te-binding-delivery">
              {t("openclaw.teProvider.bindingDelivery", {
                defaultValue: "Binding delivery method",
              })}
            </Label>
            <Select
              value={value.bindingDelivery}
              onValueChange={(next) =>
                update({ bindingDelivery: next as OpenClawTeBindingDelivery })
              }
            >
              <SelectTrigger
                id="te-binding-delivery"
                data-testid="te-binding-delivery"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="config-headers" disabled>
                  {t("openclaw.teProvider.bindingDeliveryHeaders", {
                    defaultValue: "Write to Agent config header",
                  })}
                </SelectItem>
                <SelectItem value="gateway-plugin">
                  {t("openclaw.teProvider.bindingDeliveryPlugin", {
                    defaultValue: "OpenClaw Gateway plugin",
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Only the Gateway plugin is currently supported; config-header
              delivery is not yet wired into the private runtime configuration.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="te-provider-timeout">
              {t("openclaw.teProvider.providerTimeoutSeconds", {
                defaultValue: "Provider timeout (seconds)",
              })}
            </Label>
            <Input
              id="te-provider-timeout"
              data-testid="te-provider-timeout"
              inputMode="numeric"
              value={value.providerTimeoutSeconds ?? ""}
              onChange={(event) =>
                update({
                  providerTimeoutSeconds: numberOrUndefined(event.target.value),
                })
              }
              placeholder={String(TE_PROVIDER_DEFAULT_TIMEOUT_SECONDS)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="te-keep-alive">
              {t("openclaw.teProvider.keepAliveIntervalSeconds", {
                defaultValue: "Keep-alive interval (seconds)",
              })}
            </Label>
            <Input
              id="te-keep-alive"
              data-testid="te-keep-alive"
              inputMode="numeric"
              value={value.keepAliveIntervalSeconds ?? ""}
              onChange={(event) =>
                update({
                  keepAliveIntervalSeconds: numberOrUndefined(
                    event.target.value,
                  ),
                })
              }
              placeholder={String(TE_PROVIDER_DEFAULT_KEEP_ALIVE_SECONDS)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Custom timeout and keep-alive values are not yet persisted; only the
            defaults of 300 seconds / 30 seconds can be saved.
          </p>
        </div>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">
              {t("openclaw.teProvider.models", {
                defaultValue: "Model capability metadata",
              })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("openclaw.teProvider.modelsHint", {
                defaultValue:
                  "Leave blank to mark unknown; capabilities are not inferred from blank values. Only platform-verified capabilities can be used as approval evidence.",
              })}
            </p>
          </div>
          <button
            type="button"
            className="text-xs underline"
            data-testid="te-add-model"
            onClick={() =>
              update({
                models: [...value.models, { id: "", name: "" }],
              })
            }
          >
            {t("openclaw.teProvider.addModel", { defaultValue: "Add model" })}
          </button>
        </div>

        {value.models.map((model, index) => (
          <div
            key={`${index}-${model.id}`}
            className="rounded-md border p-3 space-y-3"
            data-testid="te-model-row"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>
                  {t("openclaw.teProvider.modelId", {
                    defaultValue: "Model ID",
                  })}
                </Label>
                <Input
                  data-testid="te-model-id"
                  value={model.id}
                  onChange={(event) =>
                    updateModel(index, { id: event.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>
                  {t("openclaw.teProvider.modelName", {
                    defaultValue: "Display name",
                  })}
                </Label>
                <Input
                  data-testid="te-model-name"
                  value={model.name}
                  onChange={(event) =>
                    updateModel(index, { name: event.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>
                  {t("openclaw.teProvider.contextWindowTokens", {
                    defaultValue: "Context length (tokens)",
                  })}
                </Label>
                <Input
                  data-testid="te-model-context-window"
                  inputMode="numeric"
                  value={model.contextWindowTokens ?? ""}
                  onChange={(event) =>
                    updateModel(index, {
                      contextWindowTokens: numberOrUndefined(
                        event.target.value,
                      ),
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>
                  {t("openclaw.teProvider.maxOutputTokens", {
                    defaultValue: "Maximum output (tokens)",
                  })}
                </Label>
                <Input
                  data-testid="te-model-max-output"
                  inputMode="numeric"
                  value={model.maxOutputTokens ?? ""}
                  onChange={(event) =>
                    updateModel(index, {
                      maxOutputTokens: numberOrUndefined(event.target.value),
                    })
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>
                {t("openclaw.teProvider.inputModalities", {
                  defaultValue: "Input modality",
                })}
              </Label>
              <div className="flex flex-wrap gap-3">
                {INPUT_MODALITIES.map((item) => (
                  <label key={item} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      data-testid={`te-model-input-${item}`}
                      checked={(model.inputModalities ?? []).includes(item)}
                      onCheckedChange={(checked) =>
                        updateModel(index, {
                          inputModalities: toggleList(
                            model.inputModalities,
                            item,
                            checked === true,
                          ),
                        })
                      }
                    />
                    {item}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>
                {t("openclaw.teProvider.outputModalities", {
                  defaultValue: "Output modality",
                })}
              </Label>
              <div className="flex flex-wrap gap-3">
                {OUTPUT_MODALITIES.map((item) => (
                  <label key={item} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      data-testid={`te-model-output-${item}`}
                      checked={(model.outputModalities ?? []).includes(item)}
                      onCheckedChange={(checked) =>
                        updateModel(index, {
                          outputModalities: toggleList(
                            model.outputModalities,
                            item,
                            checked === true,
                          ),
                        })
                      }
                    />
                    {item}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>
                {t("openclaw.teProvider.reasoningEfforts", {
                  defaultValue: "Reasoning effort",
                })}
              </Label>
              <div className="flex flex-wrap gap-3">
                {REASONING_EFFORTS.map((item) => (
                  <label key={item} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      data-testid={`te-model-reasoning-${item}`}
                      checked={(model.reasoningEfforts ?? []).includes(item)}
                      onCheckedChange={(checked) =>
                        updateModel(index, {
                          reasoningEfforts: toggleList(
                            model.reasoningEfforts,
                            item,
                            checked === true,
                          ),
                        })
                      }
                    />
                    {item}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  data-testid="te-model-supports-tools"
                  checked={model.supportsTools === true}
                  onCheckedChange={(checked) =>
                    updateModel(index, { supportsTools: checked === true })
                  }
                />
                {t("openclaw.teProvider.supportsTools", {
                  defaultValue: "Supports tool calling",
                })}
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  data-testid="te-model-supports-reasoning"
                  checked={model.supportsReasoning === true}
                  onCheckedChange={(checked) =>
                    updateModel(index, { supportsReasoning: checked === true })
                  }
                />
                {t("openclaw.teProvider.supportsReasoning", {
                  defaultValue: "Supports reasoning",
                })}
              </label>
            </div>
          </div>
        ))}
      </div>

      {errors.length > 0 && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
          role="alert"
          data-testid="te-provider-errors"
        >
          <p className="text-xs font-medium">
            {t("openclaw.teProvider.invalid", {
              defaultValue:
                "Current settings cannot yet be written to Agent configuration",
            })}
          </p>
          <ul className="mt-1 list-disc pl-4 text-xs">
            {errors.map((code) => (
              <li key={code}>{errorLabel(code)}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
        <h3 className="text-sm font-medium">
          {t("openclaw.teProvider.runtimeFields", {
            defaultValue: "Runtime-injected fields (not persisted)",
          })}
        </h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {runtimeFields.map((field) => (
            <li key={field.field} data-testid="te-runtime-field">
              <span className="font-mono">{field.field}</span>
              {" · "}
              {field.filledBy}
              {" · "}
              {t(`openclaw.teProvider.bindingNotes.${field.field}`)}
            </li>
          ))}
        </ul>
      </div>

      <div
        className="rounded-lg border p-4 space-y-3"
        data-testid="te-runtime-status"
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">
              {t("openclaw.teProvider.runtimeStatus", {
                defaultValue: "Runtime status (read-only probe)",
              })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("openclaw.teProvider.runtimeStatusHint", {
                defaultValue:
                  "Checks only injector liveness and upstream availability; Task, lease, session, and binding are never read, displayed, or persisted.",
              })}
            </p>
          </div>
          <button
            type="button"
            className="text-xs underline"
            data-testid="te-refresh-runtime"
            disabled={runtimeBusy}
            onClick={() => void refreshRuntimeStatus()}
          >
            {runtimeBusy
              ? t("openclaw.teProvider.runtimeChecking", {
                  defaultValue: "Checking…",
                })
              : t("openclaw.teProvider.runtimeRefresh", {
                  defaultValue: "Refresh runtime status",
                })}
          </button>
        </div>

        {runtimeError ? (
          <p
            className="text-xs text-destructive"
            data-testid="te-runtime-error"
          >
            {runtimeError}
          </p>
        ) : null}

        {runtimeStatus ? (
          <ul className="space-y-1 text-xs" data-testid="te-runtime-summary">
            <li>
              Injector:
              {runtimeStatus.sidecarReachable
                ? `Alive (${runtimeStatus.sidecarStatus ?? "ok"}, ${runtimeStatus.latencyMs}ms)`
                : `Unreachable (${runtimeStatus.sidecarError ?? "connect_failed"})`}
            </li>
            <li>{providerStatusText(runtimeStatus)}</li>
            <li>
              Checked at:{runtimeStatus.checkedAt}
              {runtimeStatus.provider?.checkedAt
                ? ` · Probe time ${runtimeStatus.provider.checkedAt}`
                : ""}
            </li>
            <li data-testid="te-runtime-binding-note">
              Runtime binding:
              {runtimeStatus.runtimeBindingExposed
                ? "Readable"
                : "Not exposed over HTTP (by design)"}
            </li>
          </ul>
        ) : null}
      </div>
    </div>
  );
}
