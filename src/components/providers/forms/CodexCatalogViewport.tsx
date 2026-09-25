import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { CodexCatalogModel } from "@/types";
import { cn } from "@/lib/utils";
import { codexInputCapabilityState } from "./codexInputCapability";

export function CodexCatalogViewport<
  T extends CodexCatalogModel & { rowId: string },
>({
  items,
  compact,
  selected,
  onSelect,
  onToggleEnabled,
  showSelection = true,
  revealRowId,
  onVisibleItemsChange,
  children,
}: {
  items: { row: T; index: number }[];
  compact: boolean;
  selected: ReadonlySet<string>;
  onSelect: (id: string, checked: boolean) => void;
  onToggleEnabled?: (id: string, enabled: boolean) => void;
  showSelection?: boolean;
  revealRowId?: string;
  onVisibleItemsChange?: (items: { row: T; index: number }[]) => void;
  children: (item: { row: T; index: number }) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState<string | null>(null);
  const identity = JSON.stringify(items.map(({ row }) => row.rowId));
  const [pagination, setPagination] = useState({ identity, page: 0 });
  const [lastRevealed, setLastRevealed] = useState(revealRowId);
  if (revealRowId !== lastRevealed) {
    setLastRevealed(revealRowId);
    const index = items.findIndex(({ row }) => row.rowId === revealRowId);
    if (index >= 0) {
      setPagination({ identity, page: Math.floor(index / 10) });
      setExpanded(revealRowId ?? null);
    }
  }
  // Filtering and sorting start at the first page; edits retain stable row IDs.
  const page = pagination.identity === identity ? pagination.page : 0;
  const pageSize = 10;
  const pageCount = Math.ceil(items.length / pageSize);
  const start = page * pageSize;
  const visibleItems = useMemo(
    () => (compact ? items.slice(start, start + pageSize) : items),
    [compact, items, start],
  );

  useEffect(() => {
    onVisibleItemsChange?.(visibleItems);
  }, [onVisibleItemsChange, visibleItems]);

  if (!compact) {
    if (!showSelection && !onToggleEnabled) {
      return <>{visibleItems.map(children)}</>;
    }
    return (
      <div className="min-w-0 border-y">
        {visibleItems.map((entry) => {
          const { row } = entry;
          return (
            <div
              key={row.rowId}
              className="flex min-w-0 items-start gap-3 border-b p-2 last:border-b-0"
            >
              {(showSelection || onToggleEnabled) && (
                <label className="flex shrink-0 items-center gap-1.5 pt-1 text-xs font-medium">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border-default"
                    checked={
                      onToggleEnabled
                        ? row.enabled !== false
                        : selected.has(row.rowId)
                    }
                    onChange={(event) =>
                      onToggleEnabled
                        ? onToggleEnabled(row.rowId, event.target.checked)
                        : onSelect(row.rowId, event.target.checked)
                    }
                    aria-label={t(
                      onToggleEnabled
                        ? "codexConfig.catalogIncludeModel"
                        : "codexConfig.catalogSelectModel",
                      {
                        model: row.model,
                        defaultValue: onToggleEnabled
                          ? "Include {{model}}"
                          : "Select {{model}}",
                      },
                    )}
                  />
                  {onToggleEnabled && (
                    <span className="hidden sm:inline">
                      {t("codexConfig.catalogIncludeLabel", {
                        defaultValue: "Include",
                      })}
                    </span>
                  )}
                </label>
              )}
              <div className="min-w-0 flex-1">{children(entry)}</div>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="min-w-0 border-y">
      {items.length > pageSize && (
        <div className="flex items-center justify-end gap-2 border-b py-1 text-xs tabular-nums">
          <span aria-live="polite">
            {t("opencode.modelRange", {
              from: start + 1,
              to: Math.min(start + pageSize, items.length),
              total: items.length,
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={page === 0}
            aria-label={t("opencode.previousModels")}
            title={t("opencode.previousModels")}
            onClick={() => setPagination({ identity, page: page - 1 })}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={page + 1 >= pageCount}
            aria-label={t("opencode.nextModels")}
            title={t("opencode.nextModels")}
            onClick={() => setPagination({ identity, page: page + 1 })}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
      <div>
        {visibleItems.map((entry) => {
          if (!showSelection) return children(entry);
          const { row } = entry;
          const open = expanded === row.rowId;
          const editorId = `${id}-${row.rowId}`;
          const state = codexInputCapabilityState(row);
          const modalities = row.inputModalities ?? row.input_modalities;
          return (
            <div
              key={row.rowId}
              className={cn(
                "min-w-0 border-b last:border-b-0",
                selected.has(row.rowId) && "bg-primary/5",
              )}
            >
              <div className="flex min-h-[52px] items-center gap-3 px-2">
                {!onToggleEnabled && showSelection && (
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0"
                    checked={selected.has(row.rowId)}
                    aria-label={t("codexConfig.catalogSelectModel", {
                      model: row.model,
                      defaultValue: "Select {{model}}",
                    })}
                    onChange={(event) =>
                      onSelect(row.rowId, event.target.checked)
                    }
                  />
                )}
                {onToggleEnabled && (
                  <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border-default"
                      checked={row.enabled !== false}
                      onChange={(event) =>
                        onToggleEnabled(row.rowId, event.target.checked)
                      }
                      aria-label={t("codexConfig.catalogIncludeModel", {
                        model: row.model,
                        defaultValue: "Include {{model}}",
                      })}
                    />
                    <span className="hidden sm:inline">
                      {t("codexConfig.catalogIncludeLabel", {
                        defaultValue: "Include",
                      })}
                    </span>
                  </label>
                )}
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    row.enabled !== false ? "bg-emerald-500" : "bg-destructive",
                  )}
                  title={t(
                    row.enabled !== false
                      ? "codexConfig.catalogUsedStatus"
                      : "codexConfig.catalogNotUsedStatus",
                  )}
                />
                <div className="min-w-0 flex-1 break-words py-2 text-sm">
                  <div>{row.displayName || row.model}</div>
                  {row.displayName && row.displayName !== row.model && (
                    <div className="text-xs text-muted-foreground">
                      {row.model}
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    "max-w-[35%] break-words text-xs",
                    state === "unknown"
                      ? "text-yellow-800 dark:text-yellow-200"
                      : "text-primary",
                  )}
                >
                  {modalities?.length
                    ? modalities.join(", ")
                    : t(
                        state === "unknown"
                          ? "common.unknown"
                          : state === "text_image"
                            ? "codexForm.textAndImageLabel"
                            : "codexForm.textOnlyLabel",
                      )}
                </span>
                <span className="hidden w-24 shrink-0 text-right text-xs tabular-nums sm:block">
                  {row.contextWindow ?? row.context_window ?? ""}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-expanded={open}
                  aria-controls={editorId}
                  aria-label={t("catalogBrowser.editModel", {
                    model: row.model,
                  })}
                  title={t("catalogBrowser.editModel", { model: row.model })}
                  onClick={() => setExpanded(open ? null : row.rowId)}
                >
                  {open ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {open && (
                <div
                  id={editorId}
                  className="min-w-0 border-t bg-muted/20 px-2 py-3"
                >
                  {children(entry)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
