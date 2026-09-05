import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CodexApiKeyGroup } from "@/types";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";

// Keep separators while typing; parsing directly into the controlled input
// otherwise removes the comma before the next model can be entered.
function ModelListInput({
  values,
  label,
  onChange,
}: {
  values: string[];
  label: string;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState(values.join(", "));
  const lastEmitted = useRef(JSON.stringify(values));
  const serialized = JSON.stringify(values);
  useEffect(() => {
    if (serialized !== lastEmitted.current) {
      setDraft((JSON.parse(serialized) as string[]).join(", "));
      lastEmitted.current = serialized;
    }
  }, [serialized]);
  return (
    <Input
      aria-label={label}
      placeholder={label}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = event.target.value
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        lastEmitted.current = JSON.stringify(next);
        onChange(next);
      }}
    />
  );
}

export function CodexKeyGroupModels({
  group,
  baseUrl,
  isFullUrl,
  customUserAgent,
  onChange,
  onModelsFetched,
}: {
  group: CodexApiKeyGroup;
  baseUrl: string;
  isFullUrl?: boolean;
  customUserAgent?: string;
  onChange: (group: CodexApiKeyGroup) => void;
  onModelsFetched: (models: FetchedModel[]) => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const identity = JSON.stringify([group, baseUrl, isFullUrl, customUserAgent]);
  const current = useRef({ identity, onChange, onModelsFetched });
  current.current = { identity, onChange, onModelsFetched };
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current += 1;
    setLoading(false);
    return () => {
      sequence.current += 1;
    };
  }, [identity]);

  const fetchForGroup = async () => {
    const keys = Array.from(
      new Set(group.apiKeys.map((key) => key.trim()).filter(Boolean)),
    );
    const request = ++sequence.current;
    setLoading(true);
    try {
      const lists = await Promise.all(
        (group.strategy === "fixed" ? keys.slice(0, 1) : keys).map((key) =>
          fetchModelsForConfig(
            baseUrl,
            key,
            isFullUrl,
            undefined,
            customUserAgent,
          ),
        ),
      );
      if (request !== sequence.current || identity !== current.current.identity)
        return;
      const models = Array.from(
        new Map(lists.flat().map((model) => [model.id, model])).values(),
      );
      if (models.length === 0) {
        toast.info(t("providerForm.fetchModelsEmpty"));
        return;
      }
      current.current.onChange({
        ...group,
        models: Array.from(
          new Set([
            ...(group.models ?? []),
            ...models.map((model) => model.id),
          ]),
        ),
      });
      current.current.onModelsFetched(models);
    } catch (error) {
      if (request === sequence.current && identity === current.current.identity)
        showFetchModelsError(error, t);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-2">
        <ModelListInput
          values={group.models ?? []}
          label={t("codexConfig.apiKeyGroupModels", {
            defaultValue: "Exact models, comma separated",
          })}
          onChange={(models) => onChange({ ...group, models })}
        />
        <ModelListInput
          values={group.prefixes ?? []}
          label={t("codexConfig.apiKeyGroupPrefixes", {
            defaultValue: "Model prefixes, comma separated",
          })}
          onChange={(prefixes) => onChange({ ...group, prefixes })}
        />
      </div>
      {group.strategy === "fixed" &&
        !(group.models?.length || group.prefixes?.length) && (
          <p
            role="status"
            className="text-xs text-amber-600 dark:text-amber-400"
          >
            {t("codexConfig.apiKeyGroupUnassigned")}
          </p>
        )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={
          loading || !baseUrl.trim() || !group.apiKeys.some((key) => key.trim())
        }
        onClick={fetchForGroup}
      >
        {loading ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="mr-1 h-3.5 w-3.5" />
        )}
        {t("codexConfig.apiKeyGroupFetchModels")}
      </Button>
    </div>
  );
}
