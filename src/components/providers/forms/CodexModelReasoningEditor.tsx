import type {
  CodexModelReasoningCapability,
  CodexReasoningControlKind,
  CodexReasoningEffort,
} from "@/types";

const PROVIDER_EFFORTS: CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function identityCompleteMap(
  capability: CodexModelReasoningCapability,
): Partial<Record<CodexReasoningEffort, CodexReasoningEffort>> {
  const completed = { ...capability.upstream.effortMap };
  for (const effort of capability.supportedEfforts) {
    completed[effort] ??= effort;
  }
  return completed;
}

export interface CodexModelReasoningEditorProps {
  model: string;
  capability: CodexModelReasoningCapability;
  readOnly: boolean;
  onChange: (capability: CodexModelReasoningCapability) => void;
}

/**
 * 模型级推理能力的结构化编辑器。Provider 原生能力、上游 wire 契约与
 * Codex 映射分组展示，避免用户把三个层面的档位误当成同一字段。
 */
export function CodexModelReasoningEditor({
  model,
  capability,
  readOnly,
  onChange,
}: CodexModelReasoningEditorProps) {
  const isGraded =
    (capability.controlKind ??
      (capability.supportedEfforts.length ? "graded" : "unknown")) === "graded";
  const completedMap = identityCompleteMap(capability);
  const addableEfforts = PROVIDER_EFFORTS.filter(
    (effort) => !capability.supportedEfforts.includes(effort),
  );

  const update = (next: CodexModelReasoningCapability) =>
    onChange({ ...next, schemaVersion: 2, source: "user" });

  const updateControlKind = (controlKind: CodexReasoningControlKind) => {
    const graded = controlKind === "graded";
    const boolean = controlKind === "boolean";
    update({
      ...capability,
      supportStatus:
        controlKind === "none"
          ? "confirmed_unsupported"
          : "confirmed_supported",
      controlKind,
      supportedEfforts: graded ? capability.supportedEfforts : [],
      defaultEffort: graded ? capability.defaultEffort : undefined,
      disableAllowed: boolean ? capability.disableAllowed : false,
      upstream: graded
        ? {
            ...capability.upstream,
            format:
              capability.upstream.format === "string" ||
              capability.upstream.format === "reasoning_object"
                ? capability.upstream.format
                : "string",
            parameter:
              capability.upstream.parameter === "reasoning.effort"
                ? "reasoning.effort"
                : "reasoning_effort",
            effortMap: completedMap,
          }
        : boolean
          ? {
              format: "boolean",
              parameter: "enable_thinking",
              effortMap: {},
            }
          : { format: "none", parameter: "none", effortMap: {} },
    });
  };

  return (
    <div className="space-y-4 text-xs">
      <label className="grid gap-1">
        <span className="font-medium">Control mode</span>
        <select
          className="rounded-md border bg-background px-3 py-2"
          aria-label={`${model} reasoning control`}
          value={capability.controlKind ?? (isGraded ? "graded" : "unknown")}
          disabled={readOnly}
          onChange={(event) =>
            updateControlKind(event.target.value as CodexReasoningControlKind)
          }
        >
          <option value="graded">Graded reasoning (effort)</option>
          <option value="boolean">Reasoning toggle only</option>
          <option value="budget">Reasoning token budget</option>
          <option value="none">Reasoning unsupported</option>
          <option value="unknown">Unconfirmed</option>
        </select>
        <span className="text-muted-foreground">
          Select the actual control mode exposed by the provider for this model;
          keep it “Unconfirmed” when unknown.
        </span>
      </label>

      {isGraded ? (
        <>
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 font-medium">
              Native provider capability
            </legend>
            <p className="text-muted-foreground">
              Select only the levels this provider API actually accepts for the
              model, not the complete Codex level set.
            </p>
            <div className="flex flex-wrap gap-3">
              {capability.supportedEfforts.map((effort) => (
                <label key={effort} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    aria-label={`Provider-native effort ${effort}`}
                    checked
                    disabled={readOnly}
                    onChange={() => {
                      const supportedEfforts =
                        capability.supportedEfforts.filter(
                          (candidate) => candidate !== effort,
                        );
                      const effortMap = { ...capability.upstream.effortMap };
                      for (const [source, target] of Object.entries(
                        effortMap,
                      )) {
                        if (target === effort) {
                          delete effortMap[source as CodexReasoningEffort];
                        }
                      }
                      update({
                        ...capability,
                        supportedEfforts,
                        defaultEffort: supportedEfforts.includes(
                          capability.defaultEffort as CodexReasoningEffort,
                        )
                          ? capability.defaultEffort
                          : supportedEfforts[0],
                        upstream: { ...capability.upstream, effortMap },
                      });
                    }}
                  />
                  {effort}
                </label>
              ))}
            </div>
            {addableEfforts.length ? (
              <label className="grid max-w-xs gap-1">
                <span>Add provider level</span>
                <select
                  className="rounded-md border bg-background px-3 py-2"
                  aria-label="Add native provider level"
                  value=""
                  disabled={readOnly}
                  onChange={(event) => {
                    const effort = event.target.value as CodexReasoningEffort;
                    if (!effort) return;
                    update({
                      ...capability,
                      supportedEfforts: [
                        ...capability.supportedEfforts,
                        effort,
                      ],
                      defaultEffort: capability.defaultEffort ?? effort,
                      upstream: {
                        ...capability.upstream,
                        effortMap: { ...completedMap, [effort]: effort },
                      },
                    });
                  }}
                >
                  <option value="">Select a level to add…</option>
                  {addableEfforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>

          <label className="grid gap-1">
            <span className="font-medium">Provider default level</span>
            <select
              className="rounded-md border bg-background px-3 py-2"
              aria-label={`${model} provider default effort`}
              value={capability.defaultEffort ?? ""}
              disabled={readOnly}
              onChange={(event) =>
                update({
                  ...capability,
                  defaultEffort:
                    (event.target.value as CodexReasoningEffort) || undefined,
                })
              }
            >
              <option value="">Not declared</option>
              {capability.supportedEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">
              Used when Codex does not specify an explicit level; it must be one
              of the native levels selected above.
            </span>
          </label>

          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 font-medium">Upstream parameter</legend>
            <label className="grid gap-1">
              <span>Parameter shape</span>
              <select
                className="rounded-md border bg-background px-3 py-2"
                aria-label={`${model} upstream parameter format`}
                value={capability.upstream.format}
                disabled={readOnly}
                onChange={(event) => {
                  const format = event.target.value as
                    "string" | "reasoning_object";
                  update({
                    ...capability,
                    upstream: {
                      ...capability.upstream,
                      format,
                      parameter:
                        format === "reasoning_object"
                          ? "reasoning.effort"
                          : "reasoning_effort",
                      effortMap: completedMap,
                    },
                  });
                }}
              >
                <option value="string">Top-level string parameter</option>
                <option value="reasoning_object">reasoning object</option>
              </select>
            </label>
            <label className="grid gap-1">
              <span>Upstream parameter name</span>
              <input
                className="rounded-md border bg-background px-3 py-2"
                aria-label={`${model} upstream parameter name`}
                value={capability.upstream.parameter}
                readOnly={readOnly}
                onChange={(event) =>
                  update({
                    ...capability,
                    upstream: {
                      ...capability.upstream,
                      parameter: event.target
                        .value as CodexModelReasoningCapability["upstream"]["parameter"],
                      effortMap: completedMap,
                    },
                  })
                }
              />
              <span className="text-muted-foreground">
                Example: reasoning_effort (top-level string) or reasoning.effort
                (object field).
              </span>
            </label>
          </fieldset>

          <fieldset
            className="space-y-2 rounded-md border p-3"
            aria-label={`${model} Codex-to-provider mapping`}
          >
            <legend className="px-1 font-medium">
              Codex → provider mapping
            </legend>
            <p className="text-muted-foreground">
              Same-named levels receive an identity mapping automatically; edit
              only when names differ or a downgrade is needed. Every selectable
              level for the model must have a valid target when saving.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {capability.supportedEfforts.map((effort) => (
                <label
                  key={effort}
                  className="grid grid-cols-[1fr_auto_1fr] items-center gap-1"
                >
                  <span>{effort}</span>
                  <span>→</span>
                  <select
                    className="rounded border bg-background px-2 py-1"
                    aria-label={`${effort} mapping target`}
                    value={completedMap[effort] ?? ""}
                    disabled={readOnly}
                    onChange={(event) =>
                      update({
                        ...capability,
                        upstream: {
                          ...capability.upstream,
                          effortMap: {
                            ...completedMap,
                            [effort]: event.target
                              .value as CodexReasoningEffort,
                          },
                        },
                      })
                    }
                  >
                    {capability.supportedEfforts.map((target) => (
                      <option key={target} value={target}>
                        {target}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <p className="rounded-md border bg-muted/30 p-3 text-muted-foreground">
          This control mode does not use effort levels, so no Codex → provider
          mapping is required.
        </p>
      )}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={capability.disableAllowed}
          disabled={readOnly || capability.controlKind === "none"}
          onChange={(event) =>
            update({ ...capability, disableAllowed: event.target.checked })
          }
        />
        Provider supports explicitly disabling reasoning
      </label>
    </div>
  );
}
