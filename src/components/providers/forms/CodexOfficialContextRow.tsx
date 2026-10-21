import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { getCodexOfficialModelSpec } from "@/config/codexOfficialModelSpecs";
import { getCodexOfficialContextDefault } from "@/config/codexOfficialContextDefaults";
import type { FetchedModel } from "@/lib/api/model-fetch";

interface Props {
  model: string;
  upstreamModel?: string;
  value: string;
  discovered?: FetchedModel;
  maximumIsTrusted?: boolean;
  onChange: (value: string) => void;
}

function positiveTokenLimit(
  value: number | null | undefined,
): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function CodexOfficialContextRow({
  model,
  upstreamModel,
  value,
  discovered,
  maximumIsTrusted = false,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const defaultWindow = positiveTokenLimit(discovered?.contextWindow);
  const displayedMaximum = positiveTokenLimit(discovered?.maxContextWindow);
  const maximum = maximumIsTrusted ? displayedMaximum : undefined;
  const hasMaximum = maximum !== undefined;
  const modelId = upstreamModel?.trim() || model;
  const apiSpec = getCodexOfficialModelSpec(modelId);
  const officialDefault = getCodexOfficialContextDefault(modelId);
  // An explicit default is safe to restore/lower, but is not evidence of a larger maximum.
  const ceiling = maximum ?? defaultWindow;
  const directoryDefaultSelectable = Boolean(
    defaultWindow &&
    ceiling &&
    defaultWindow <= ceiling &&
    (hasMaximum || defaultWindow < 1_000_000),
  );
  const presets = [
    ...new Set([
      128_000,
      256_000,
      officialDefault?.contextWindow,
      512_000,
      1_000_000,
    ]),
  ]
    .filter(
      (tokens): tokens is number => positiveTokenLimit(tokens) !== undefined,
    )
    .filter(
      (tokens) =>
        ceiling &&
        tokens <= ceiling &&
        (hasMaximum || tokens < 1_000_000) &&
        tokens !== defaultWindow &&
        tokens !== maximum,
    );
  const selected = !value
    ? "default"
    : maximum && Number(value) === maximum
      ? String(maximum)
      : (directoryDefaultSelectable && Number(value) === defaultWindow) ||
          presets.includes(Number(value))
        ? String(Number(value))
        : "custom";
  const requiresTrustedMaximum = Boolean(
    value && !hasMaximum && Number(value) >= 1_000_000,
  );
  const invalid = Boolean(
    value &&
    (Number(value) <= 0 ||
      !Number.isSafeInteger(Number(value)) ||
      (ceiling && Number(value) > ceiling) ||
      requiresTrustedMaximum),
  );
  const unknown = t("codexConfig.officialTokensUnknown");
  const discoveredOutputLimit = positiveTokenLimit(discovered?.maxOutputTokens);
  const outputSource = discoveredOutputLimit
    ? t("codexConfig.officialDirectorySource")
    : apiSpec
      ? t("codexConfig.officialApiSource")
      : undefined;
  const outputValue = discoveredOutputLimit ?? apiSpec?.maxOutputTokens;
  const inputValue = positiveTokenLimit(discovered?.maxInputTokens);
  const metrics = [
    [
      t(
        displayedMaximum && !maximumIsTrusted
          ? "codexConfig.officialUnverifiedMax"
          : "codexConfig.officialContextMax",
      ),
      displayedMaximum?.toLocaleString() ?? unknown,
    ],
  ];

  return (
    <div
      className="min-w-0 space-y-2 border-b border-border-default pb-3"
      role="group"
      aria-label={model}
    >
      <div className="break-all text-sm font-medium">{model}</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs md:grid-cols-5">
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            {t("codexConfig.officialDefaultContext")}
          </dt>
          {officialDefault ? (
            <>
              <dd className="break-words tabular-nums">
                {officialDefault.contextWindow.toLocaleString()}
              </dd>
              <dd>
                <a
                  href={officialDefault.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`${officialDefault.source} · ${officialDefault.sourceDate}`}
                  className="text-primary underline"
                >
                  {t("codexConfig.officialDefaultSource")}
                </a>
              </dd>
            </>
          ) : (
            <dd className="break-words tabular-nums">
              {t("codexConfig.officialContextDefaultUnknown")}
            </dd>
          )}
          <dd className="mt-1 text-muted-foreground">
            {t("codexConfig.officialDirectoryDefault", {
              value: defaultWindow?.toLocaleString() ?? unknown,
            })}
          </dd>
        </div>
        {metrics.map(([label, text]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words tabular-nums">{text}</dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            {t("codexConfig.officialMaxInput")}
          </dt>
          <dd className="break-words tabular-nums">
            {inputValue?.toLocaleString() ??
              t("codexConfig.officialInputSharedBudget")}
          </dd>
          {inputValue && (
            <dd className="text-muted-foreground">
              {t("codexConfig.officialDirectorySource")}
            </dd>
          )}
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            {t("codexConfig.officialMaxOutput")}
          </dt>
          <dd className="break-words tabular-nums">
            {outputValue?.toLocaleString() ?? unknown}
          </dd>
          {outputSource && (
            <dd>
              {apiSpec && !discoveredOutputLimit ? (
                <a
                  href={apiSpec.documentationUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`${apiSpec.modelId} · ${apiSpec.verifiedAt}`}
                  className="text-primary underline"
                >
                  {outputSource}
                </a>
              ) : (
                <span className="text-muted-foreground">{outputSource}</span>
              )}
            </dd>
          )}
        </div>
        {apiSpec && (
          <div className="min-w-0">
            <dt className="text-muted-foreground">
              {t("codexConfig.officialApiContext")}
            </dt>
            <dd className="break-words tabular-nums">
              {apiSpec.contextWindow.toLocaleString()}
            </dd>
            <dd>
              <a
                href={apiSpec.documentationUrl}
                target="_blank"
                rel="noreferrer"
                title={`${apiSpec.modelId} · ${apiSpec.verifiedAt}`}
                className="text-primary underline"
              >
                {t("codexConfig.officialApiSource")}
              </a>
            </dd>
          </div>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">
        {maximum
          ? maximum > (defaultWindow ?? 0)
            ? t("codexConfig.officialContextCanRaise", {
                max: maximum.toLocaleString(),
              })
            : t("codexConfig.officialContextCanLower")
          : t("codexConfig.officialContextUnverified")}
        {apiSpec && (
          <span className="ml-1">
            {t("codexConfig.officialApiContextNote", {
              context: apiSpec.contextWindow.toLocaleString(),
            })}
          </span>
        )}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="min-w-0 space-y-1 text-xs">
          <span>{t("codexConfig.officialContextPreset")}</span>
          <select
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm"
            aria-label={`${model} ${t("codexConfig.officialContextPreset")}`}
            value={selected}
            onChange={(event) => {
              if (event.target.value === "custom") {
                inputRef.current?.focus();
              } else {
                onChange(
                  event.target.value === "default" ? "" : event.target.value,
                );
              }
            }}
          >
            <option value="default">
              {t("codexConfig.officialContextFollowDefault")}
            </option>
            {presets.map((tokens) => (
              <option key={tokens} value={tokens}>
                {tokens === officialDefault?.contextWindow
                  ? t("codexConfig.officialDefaultPreset", {
                      value: tokens.toLocaleString(),
                    })
                  : tokens.toLocaleString()}
              </option>
            ))}
            {defaultWindow &&
              directoryDefaultSelectable &&
              defaultWindow !== maximum && (
                <option value={defaultWindow}>
                  {t("codexConfig.officialDirectoryContext")} ·{" "}
                  {defaultWindow.toLocaleString()}
                </option>
              )}
            {maximum && (
              <option value={maximum}>
                {t("codexConfig.officialContextUseMax", {
                  max: maximum.toLocaleString(),
                })}
              </option>
            )}
            <option value="custom">
              {t("codexConfig.officialContextCustom")}
            </option>
          </select>
        </label>
        <label className="min-w-0 space-y-1 text-xs">
          <span>{t("codexConfig.officialContextWindow")} (tokens)</span>
          <Input
            ref={inputRef}
            aria-label={`${model} ${t("codexConfig.officialContextWindow")}`}
            aria-invalid={invalid}
            inputMode="numeric"
            disabled={!ceiling}
            value={value}
            placeholder={defaultWindow?.toLocaleString() ?? unknown}
            onChange={(event) =>
              onChange(event.target.value.replace(/[^0-9]/g, ""))
            }
          />
        </label>
      </div>
      {invalid && (
        <p className="text-xs text-destructive" role="alert">
          {requiresTrustedMaximum
            ? t("codexConfig.officialContextTrustedMaxRequired")
            : t("codexConfig.officialContextRange", {
                max: ceiling?.toLocaleString() ?? unknown,
              })}
        </p>
      )}
    </div>
  );
}
