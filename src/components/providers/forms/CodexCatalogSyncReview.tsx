import { useId, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type CodexCatalogSyncMode = "keep" | "disable" | "replace";

interface CodexCatalogSyncReviewProps {
  fetchedCount: number;
  addedModels: readonly string[];
  conflictingModels?: readonly { model: string; canReplace: boolean }[];
  missingModels: readonly string[];
  enabledMissingCount: number;
  hasMetadataChanges: boolean;
  coverage: "complete" | "key-groups";
  restoreFocusRef?: RefObject<HTMLButtonElement | null>;
  onApply: (mode: CodexCatalogSyncMode, includeNewModels: boolean) => void;
  onCancel: () => void;
}

export function CodexCatalogSyncReview({
  fetchedCount,
  addedModels,
  conflictingModels = [],
  missingModels,
  enabledMissingCount,
  hasMetadataChanges,
  coverage,
  restoreFocusRef,
  onApply,
  onCancel,
}: CodexCatalogSyncReviewProps) {
  const { t } = useTranslation();
  const id = useId();
  const canChangeMissing =
    fetchedCount > 0 && coverage === "complete" && missingModels.length > 0;
  const canDisableMissing = canChangeMissing && enabledMissingCount > 0;
  const hasOtherChanges = addedModels.length > 0 || hasMetadataChanges;
  const canApplyMode: Record<CodexCatalogSyncMode, boolean> = {
    keep: hasOtherChanges,
    disable: hasOtherChanges || canDisableMissing,
    replace: canChangeMissing,
  };
  const hasChanges = fetchedCount > 0 && (hasOtherChanges || canChangeMissing);
  const defaultMode: CodexCatalogSyncMode = canDisableMissing
    ? "disable"
    : canChangeMissing && !hasOtherChanges
      ? "replace"
      : "keep";
  const [mode, setMode] = useState(defaultMode);
  const [includeNewModels, setIncludeNewModels] = useState(false);
  const appliedMode =
    canChangeMissing && canApplyMode[mode] ? mode : defaultMode;
  const newModels = [...addedModels];
  const blockedModels: string[] = [];
  for (const { model, canReplace } of conflictingModels) {
    if (appliedMode === "replace" && canReplace) {
      newModels.push(model);
    } else {
      blockedModels.push(model);
    }
  }
  const hasNewModels = newModels.length > 0;
  const canApply = hasChanges && canApplyMode[appliedMode];
  const options: Array<{
    value: CodexCatalogSyncMode;
    label: string;
    description: string;
  }> = [
    {
      value: "keep",
      label: t("codexConfig.modelSync.keep", {
        defaultValue: "Keep missing models",
      }),
      description: t("codexConfig.modelSync.keepDescription", {
        defaultValue:
          "Add and update models from this list and keep all existing rows.",
      }),
    },
    {
      value: "disable",
      label: t("codexConfig.modelSync.disable", {
        defaultValue: "Disable missing models",
      }),
      description: t("codexConfig.modelSync.disableDescription", {
        defaultValue:
          "Exclude missing models from routes and pickers. Keep their rows available to edit.",
      }),
    },
    {
      value: "replace",
      label: t("codexConfig.replaceCatalog", {
        defaultValue: "Replace catalog",
      }),
      description: t("codexConfig.modelSync.replaceDescription", {
        defaultValue:
          "Remove missing rows from the catalog and keep custom settings for models that still match.",
      }),
    },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="w-[calc(100%-2rem)] max-w-xl rounded-lg"
        zIndex="top"
        onCloseAutoFocus={(event) => {
          const trigger = restoreFocusRef?.current;
          if (trigger && !trigger.disabled) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      >
        <DialogHeader className="text-left">
          <DialogTitle>
            {t("codexConfig.modelSync.title", {
              defaultValue: "Review model sync",
            })}
          </DialogTitle>
          <DialogDescription>
            {fetchedCount === 0
              ? t("codexConfig.modelSync.empty", {
                  defaultValue:
                    "The provider returned no models for this API key. Check the key’s access or try syncing again.",
                })
              : t("codexConfig.modelSync.returned", {
                  count: fetchedCount,
                  defaultValue_one: "The provider returned {{count}} model.",
                  defaultValue: "The provider returned {{count}} models.",
                })}
          </DialogDescription>
        </DialogHeader>

        {fetchedCount > 0 && (
          <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-4">
            {coverage === "key-groups" && (
              <p className="rounded-md border border-border-default bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                {t("codexConfig.modelSync.keyGroups", {
                  defaultValue:
                    "This list covers the main API key only. Sync each key group separately to check which models its keys can access.",
                })}
              </p>
            )}

            {(hasNewModels || canChangeMissing) && (
              <div
                className={cn(
                  "grid gap-3",
                  hasNewModels && canChangeMissing && "sm:grid-cols-2",
                )}
              >
                {hasNewModels && (
                  <ModelList
                    title={t("codexConfig.modelSync.added", {
                      count: newModels.length,
                      defaultValue: "New models ({{count}})",
                    })}
                    models={newModels}
                  />
                )}
                {canChangeMissing && (
                  <ModelList
                    title={t("codexConfig.modelSync.missing", {
                      count: missingModels.length,
                      defaultValue: "Missing from this list ({{count}})",
                    })}
                    description={
                      canDisableMissing
                        ? t("codexConfig.modelSync.missingIncluded", {
                            count: enabledMissingCount,
                            defaultValue: "{{count}} currently included",
                          })
                        : t("codexConfig.modelSync.missingAlreadyExcluded", {
                            defaultValue:
                              "All missing models are already excluded.",
                          })
                    }
                    models={missingModels}
                  />
                )}
              </div>
            )}

            {blockedModels.length > 0 && (
              <ModelList
                title={t("codexConfig.modelSync.conflicting", {
                  count: blockedModels.length,
                  defaultValue: "Model IDs already in use ({{count}})",
                })}
                description={t("codexConfig.modelSync.conflictingDescription", {
                  defaultValue:
                    "Another catalog row uses each of these IDs to point to a different provider model.",
                })}
                models={blockedModels}
              />
            )}

            {hasMetadataChanges && (
              <p className="text-sm text-muted-foreground">
                {t("codexConfig.modelSync.metadata", {
                  defaultValue:
                    "Updated model details are available for existing rows.",
                })}
              </p>
            )}

            {canChangeMissing && (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">
                  {t("codexConfig.modelSync.missingChoice", {
                    defaultValue: "How should sync handle missing models?",
                  })}
                </legend>
                {options.map(({ value, label, description }) => (
                  <label
                    key={value}
                    className={cn(
                      "flex items-start gap-3 rounded-md border border-border-default px-3 py-2",
                      canApplyMode[value]
                        ? "cursor-pointer hover:bg-muted/30"
                        : "cursor-not-allowed opacity-60",
                      appliedMode === value && "border-primary/50 bg-primary/5",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${id}-sync-mode`}
                      value={value}
                      checked={appliedMode === value}
                      disabled={!canApplyMode[value]}
                      onChange={() => setMode(value)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                      aria-labelledby={`${id}-${value}-label`}
                      aria-describedby={`${id}-${value}-description`}
                    />
                    <span className="space-y-0.5 text-sm">
                      <span
                        id={`${id}-${value}-label`}
                        className="block font-medium"
                      >
                        {label}
                      </span>
                      <span
                        id={`${id}-${value}-description`}
                        className="block text-xs text-muted-foreground"
                      >
                        {description}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            {hasNewModels && (
              <div className="flex items-start gap-3">
                <Checkbox
                  id={`${id}-include-new`}
                  className="mt-0.5"
                  checked={includeNewModels}
                  onCheckedChange={(checked) =>
                    setIncludeNewModels(checked === true)
                  }
                  aria-describedby={`${id}-include-new-help`}
                />
                <div className="space-y-0.5">
                  <label
                    htmlFor={`${id}-include-new`}
                    className="cursor-pointer text-sm font-medium"
                  >
                    {t("codexConfig.modelSync.includeNew", {
                      defaultValue: "Include new models",
                    })}
                  </label>
                  <p
                    id={`${id}-include-new-help`}
                    className="text-xs text-muted-foreground"
                  >
                    {t("codexConfig.modelSync.includeNewHelp", {
                      defaultValue:
                        "Enable new models for routes and pickers, or add them as excluded rows to review later.",
                    })}
                  </p>
                </div>
              </div>
            )}

            {!canApply && (
              <p className="text-sm text-muted-foreground">
                {t("codexConfig.modelSync.noChanges", {
                  defaultValue: "There are no catalog changes to apply.",
                })}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {hasChanges && (
            <p className="pr-2 text-xs text-muted-foreground">
              {t("codexConfig.modelSync.saveHint", {
                defaultValue: "Save the provider to use these changes.",
              })}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 sm:ml-auto sm:flex-nowrap">
            <Button
              type="button"
              variant={hasChanges ? "outline" : "default"}
              onClick={onCancel}
            >
              {hasChanges
                ? t("common.cancel", { defaultValue: "Cancel" })
                : t("common.close", { defaultValue: "Close" })}
            </Button>
            {hasChanges && (
              <Button
                type="button"
                variant={appliedMode === "replace" ? "destructive" : "default"}
                disabled={!canApply}
                onClick={() =>
                  onApply(appliedMode, hasNewModels && includeNewModels)
                }
              >
                {t("codexConfig.modelSync.apply", {
                  defaultValue: "Apply to draft",
                })}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelList({
  title,
  description,
  models,
}: {
  title: string;
  description?: string;
  models: readonly string[];
}) {
  const titleId = useId();
  return (
    <section className="min-w-0 rounded-md border border-border-default bg-muted/20 p-3">
      <h3 id={titleId} className="text-sm font-medium">
        {title}
      </h3>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <ul
        aria-labelledby={titleId}
        tabIndex={models.length > 4 ? 0 : undefined}
        className="mt-2 max-h-24 space-y-1 overflow-y-auto rounded-sm text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {models.map((model, index) => (
          <li
            key={`${index}-${model}`}
            className="break-all rounded-sm bg-background px-2 py-1 font-mono"
          >
            {model}
          </li>
        ))}
      </ul>
    </section>
  );
}
