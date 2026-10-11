import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  ListX,
  MoreHorizontal,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CodexCatalogModel } from "@/types";
import { cn } from "@/lib/utils";
import { modelIdentityValues } from "@/lib/modelIdentities";
import { codexInputCapabilityState } from "./codexInputCapability";

const COMPACT_PAGE_SIZE = 10;

export function CodexCatalogViewport<
  T extends CodexCatalogModel & { rowId: string },
>({
  items,
  compact,
  selected,
  onSelect,
  onToggleEnabled,
  onSetIncluded,
  onSelectionChange,
  onUseOnlySelected,
  onRemoveSelected,
  onPruneOutdated,
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
  onSetIncluded?: (ids: string[], enabled: boolean) => void;
  onSelectionChange?: (ids: Set<string>) => void;
  onUseOnlySelected?: (ids: string[]) => void;
  onRemoveSelected?: (ids: string[]) => void;
  onPruneOutdated?: () => void;
  showSelection?: boolean;
  revealRowId?: string;
  onVisibleItemsChange?: (items: { row: T; index: number }[]) => void;
  children: (item: { row: T; index: number }) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "included" | "excluded">("all");
  const [capability, setCapability] = useState("all");
  const [sort, setSort] = useState("order");
  const filteredItems = useMemo(() => {
    if (!onToggleEnabled) return items;
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .filter(({ row }) => {
        const included = row.enabled !== false;
        if (filter === "included" && !included) return false;
        if (filter === "excluded" && included) return false;
        if (
          capability !== "all" &&
          codexInputCapabilityState(row) !== capability
        ) {
          return false;
        }
        const text = [
          ...modelIdentityValues(row),
          row.displayName,
          row.display_name,
          row.name,
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .sort((a, b) =>
        sort === "name"
          ? a.row.model.localeCompare(b.row.model)
          : sort === "context"
            ? Number(b.row.contextWindow ?? b.row.context_window ?? 0) -
              Number(a.row.contextWindow ?? a.row.context_window ?? 0)
            : a.index - b.index,
      );
  }, [capability, filter, items, onToggleEnabled, search, sort]);
  const identity = useMemo(
    () => JSON.stringify(filteredItems.map(({ row }) => row.rowId)),
    [filteredItems],
  );
  const [pagination, setPagination] = useState({ identity, page: 0 });
  const lastRevealRowId = useRef<string>();

  useEffect(() => {
    if (!revealRowId) {
      lastRevealRowId.current = undefined;
      return;
    }
    if (lastRevealRowId.current === revealRowId) return;
    const index = items.findIndex(({ row }) => row.rowId === revealRowId);
    if (index < 0) return;
    lastRevealRowId.current = revealRowId;
    setSearch("");
    setFilter("all");
    setCapability("all");
    setSort("order");
    setPagination({
      identity: JSON.stringify(items.map(({ row }) => row.rowId)),
      page: Math.floor(index / COMPACT_PAGE_SIZE),
    });
    setExpanded(revealRowId);
  }, [items, revealRowId]);

  useEffect(() => {
    if (expanded && !items.some(({ row }) => row.rowId === expanded)) {
      setExpanded(null);
    }
  }, [expanded, items]);

  const page = pagination.identity === identity ? pagination.page : 0;
  const pageCount = Math.ceil(filteredItems.length / COMPACT_PAGE_SIZE);
  const start = page * COMPACT_PAGE_SIZE;
  const visibleItems = useMemo(
    () =>
      compact
        ? filteredItems.slice(start, start + COMPACT_PAGE_SIZE)
        : filteredItems,
    [compact, filteredItems, start],
  );

  useEffect(() => {
    onVisibleItemsChange?.(visibleItems);
  }, [onVisibleItemsChange, visibleItems]);

  const includedCount = items.filter(({ row }) => row.enabled !== false).length;
  const selectedIds = items
    .filter(({ row }) => selected.has(row.rowId))
    .map(({ row }) => row.rowId);
  const allMatchingSelected =
    filteredItems.length > 0 &&
    filteredItems.every(({ row }) => selected.has(row.rowId));
  const someMatchingSelected = filteredItems.some(({ row }) =>
    selected.has(row.rowId),
  );
  const updateSelection = (mode: "matching" | "invert" | "clear") => {
    const next = new Set(selectedIds);
    if (mode === "clear") next.clear();
    else {
      filteredItems.forEach(({ row }) => {
        const remove =
          mode === "invert" ? next.has(row.rowId) : allMatchingSelected;
        if (remove) next.delete(row.rowId);
        else next.add(row.rowId);
      });
    }
    if (onSelectionChange) onSelectionChange(next);
    else {
      items.forEach(({ row }) => {
        if (selected.has(row.rowId) !== next.has(row.rowId)) {
          onSelect(row.rowId, next.has(row.rowId));
        }
      });
    }
  };
  const setIncluded = (ids: string[], enabled: boolean) => {
    if (onSetIncluded) onSetIncluded(ids, enabled);
    else ids.forEach((rowId) => onToggleEnabled?.(rowId, enabled));
  };
  const applySelected = (enabled: boolean) => {
    setIncluded(selectedIds, enabled);
    updateSelection("clear");
  };
  const browserControls = onToggleEnabled && (
    <div className="min-w-0 space-y-2 border-b py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-[1_1_240px]">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9 pr-9"
            aria-label={t("catalogBrowser.search", {
              defaultValue: "Search models",
            })}
            placeholder={t("catalogBrowser.search", {
              defaultValue: "Search models",
            })}
          />
          {search && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0.5 top-0.5 h-8 w-8"
              aria-label={t("catalogBrowser.clearSearch", {
                defaultValue: "Clear search",
              })}
              title={t("catalogBrowser.clearSearch", {
                defaultValue: "Clear search",
              })}
              onClick={() => setSearch("")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div
          role="tablist"
          aria-label={t("catalogBrowser.filter", {
            defaultValue: "Model inclusion",
          })}
          className="flex max-w-full flex-wrap rounded-md border p-0.5"
        >
          {(["all", "included", "excluded"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={cn(
                "rounded-sm px-2 py-1.5 text-xs",
                filter === value
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground",
              )}
              onClick={() => setFilter(value)}
            >
              {t(`catalogBrowser.${value}`, {
                defaultValue:
                  value === "all"
                    ? "All"
                    : value === "included"
                      ? "Included"
                      : "Excluded",
              })}{" "}
              <span className="tabular-nums">
                {value === "all"
                  ? items.length
                  : value === "included"
                    ? includedCount
                    : items.length - includedCount}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {[
          {
            label: "capability",
            value: capability,
            set: setCapability,
            options: ["all", "text_only", "text_image", "unknown"],
          },
          {
            label: "sort",
            value: sort,
            set: setSort,
            options: ["order", "name", "context"],
          },
        ].map((control) => (
          <label
            key={control.label}
            className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          >
            {t(`catalogBrowser.${control.label}`)}
            <select
              className="h-8 min-w-0 max-w-[160px] rounded-md border bg-background px-2 text-foreground"
              aria-label={t(`catalogBrowser.${control.label}`)}
              value={control.value}
              onChange={(event) => control.set(event.target.value)}
            >
              {control.options.map((option) => (
                <option key={option} value={option}>
                  {t(`catalogBrowser.${option}`)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <span
          className="mr-auto text-xs text-muted-foreground"
          aria-live="polite"
        >
          {t("catalogBrowser.matching", {
            count: filteredItems.length,
            defaultValue: "{{count}} matching models",
          })}
        </span>
      </div>
    </div>
  );
  const selectionToolbar = onToggleEnabled && showSelection && (
    <div
      role="group"
      aria-label={t("catalogBrowser.selectionActions")}
      data-catalog-selection-toolbar
      className="sticky bottom-0 z-10 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-background/95 px-2 py-2 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] backdrop-blur"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-medium">
          <Checkbox
            checked={
              allMatchingSelected
                ? true
                : someMatchingSelected
                  ? "indeterminate"
                  : false
            }
            disabled={filteredItems.length === 0}
            onCheckedChange={() => updateSelection("matching")}
            aria-label={t("catalogBrowser.selectMatching")}
          />
          {t("catalogBrowser.selectMatching")}
        </label>
        <span className="text-xs font-medium tabular-nums" aria-live="polite">
          {t("catalogBrowser.selected", { count: selectedIds.length })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={selectedIds.length === 0}
          title={t("catalogBrowser.clearSelection")}
          aria-label={t("catalogBrowser.clearSelection")}
          onClick={() => updateSelection("clear")}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto min-h-8 whitespace-normal"
          disabled={selectedIds.length === 0}
          onClick={() => applySelected(true)}
        >
          <ListChecks className="mr-1.5 h-4 w-4 shrink-0" />
          {t("catalogBrowser.includeSelected")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto min-h-8 whitespace-normal"
          disabled={selectedIds.length === 0}
          onClick={() => applySelected(false)}
        >
          <ListX className="mr-1.5 h-4 w-4 shrink-0" />
          {t("catalogBrowser.excludeSelected")}
        </Button>
        {onPruneOutdated && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto min-h-8 whitespace-normal"
            disabled={items.length < 2}
            onClick={onPruneOutdated}
          >
            <Sparkles className="mr-1.5 h-4 w-4 shrink-0" />
            {t("catalogBrowser.keepRecent")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              title={t("catalogBrowser.moreActions")}
              aria-label={t("catalogBrowser.moreActions")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={filteredItems.length === 0}
              onSelect={() => updateSelection("invert")}
            >
              <ArrowLeftRight className="h-4 w-4" />
              {t("catalogBrowser.invertSelection")}
            </DropdownMenuItem>
            {onUseOnlySelected && (
              <DropdownMenuItem
                disabled={selectedIds.length === 0}
                onSelect={() => {
                  onUseOnlySelected(selectedIds);
                  updateSelection("clear");
                }}
              >
                <ListChecks className="h-4 w-4" />
                {t("catalogBrowser.useOnlySelected")}
              </DropdownMenuItem>
            )}
            {onRemoveSelected && <DropdownMenuSeparator />}
            {onRemoveSelected && (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={selectedIds.length === 0}
                onSelect={() => {
                  onRemoveSelected(selectedIds);
                  updateSelection("clear");
                }}
              >
                <Trash2 className="h-4 w-4" />
                {t("catalogBrowser.removeSelected")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
  const emptyState = onToggleEnabled && filteredItems.length === 0 && (
    <p role="status" className="py-6 text-center text-sm text-muted-foreground">
      {t("catalogBrowser.noMatches", { defaultValue: "No matching models" })}
    </p>
  );

  if (!compact) {
    if (!showSelection && !onToggleEnabled) {
      return <>{visibleItems.map(children)}</>;
    }
    return (
      <div className="min-w-0 border-y">
        {browserControls}
        <div
          data-catalog-scroll-viewport
          className="max-h-[min(60vh,720px)] overflow-y-auto overscroll-contain"
        >
          {emptyState}
          {visibleItems.map((entry) => {
            const { row } = entry;
            return (
              <div
                key={row.rowId}
                className={cn(
                  "min-w-0 space-y-3 border-b px-2 py-3 last:border-b-0",
                  selected.has(row.rowId) && "bg-primary/5",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  {showSelection && (
                    <label className="flex min-w-0 items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected.has(row.rowId)}
                        onCheckedChange={(checked) =>
                          onSelect(row.rowId, checked === true)
                        }
                        aria-label={t("codexConfig.catalogSelectModel", {
                          model: row.model,
                          defaultValue: "Select {{model}}",
                        })}
                      />
                      <span className="min-w-0 break-words font-medium">
                        {row.displayName || row.model}
                      </span>
                    </label>
                  )}
                  {onToggleEnabled && (
                    <label className="ml-auto flex shrink-0 items-center gap-2 text-xs">
                      {t(
                        row.enabled !== false
                          ? "catalogBrowser.included"
                          : "catalogBrowser.excluded",
                      )}
                      <Switch
                        checked={row.enabled !== false}
                        onCheckedChange={(enabled) =>
                          onToggleEnabled(row.rowId, enabled)
                        }
                        aria-label={t("codexConfig.catalogIncludeModel", {
                          model: row.model,
                          defaultValue: "Include {{model}}",
                        })}
                      />
                    </label>
                  )}
                </div>
                {children(entry)}
              </div>
            );
          })}
          {selectionToolbar}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 border-y">
      {browserControls}
      {emptyState}
      {filteredItems.length > COMPACT_PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 border-b py-1 text-xs tabular-nums">
          <span aria-live="polite">
            {t("opencode.modelRange", {
              from: start + 1,
              to: Math.min(start + COMPACT_PAGE_SIZE, filteredItems.length),
              total: filteredItems.length,
              defaultValue: "Models {{from}}-{{to}} of {{total}}",
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={page === 0}
            aria-label={t("opencode.previousModels", {
              defaultValue: "Previous models",
            })}
            title={t("opencode.previousModels", {
              defaultValue: "Previous models",
            })}
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
            aria-label={t("opencode.nextModels", {
              defaultValue: "Next models",
            })}
            title={t("opencode.nextModels", {
              defaultValue: "Next models",
            })}
            onClick={() => setPagination({ identity, page: page + 1 })}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
      {showSelection && onToggleEnabled && (
        <div className="hidden items-center gap-3 border-b px-2 py-2 text-xs text-muted-foreground sm:flex">
          <span className="w-4 shrink-0" />
          <span className="min-w-0 flex-1">{t("catalogBrowser.model")}</span>
          <span className="w-28 shrink-0">{t("catalogBrowser.input")}</span>
          <span className="w-24 shrink-0 text-right">
            {t("catalogBrowser.contextWindow")}
          </span>
          <span className="w-24 shrink-0 text-right">
            {t("catalogBrowser.included")}
          </span>
          <span className="w-8 shrink-0" />
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
              <div className="flex min-h-[60px] items-center gap-2 px-2 sm:gap-3">
                <Checkbox
                  checked={selected.has(row.rowId)}
                  aria-label={t("codexConfig.catalogSelectModel", {
                    model: row.model,
                    defaultValue: "Select {{model}}",
                  })}
                  onCheckedChange={(checked) =>
                    onSelect(row.rowId, checked === true)
                  }
                />
                <div className="min-w-0 flex-1 break-words py-2 text-sm">
                  <div>{row.displayName || row.model}</div>
                  {row.displayName && row.displayName !== row.model && (
                    <div className="text-xs text-muted-foreground">
                      {row.model}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground sm:hidden">
                    {modalities?.length
                      ? modalities.join(", ")
                      : t(`catalogBrowser.${state}`)}
                    {(row.contextWindow ?? row.context_window) && (
                      <>
                        {" "}
                        ·{" "}
                        {Number(
                          row.contextWindow ?? row.context_window,
                        ).toLocaleString()}
                      </>
                    )}
                  </div>
                </div>
                <span
                  className={cn(
                    "hidden w-28 shrink-0 break-words text-xs sm:block",
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
                  {(row.contextWindow ?? row.context_window)
                    ? Number(
                        row.contextWindow ?? row.context_window,
                      ).toLocaleString()
                    : ""}
                </span>
                {onToggleEnabled && (
                  <div className="flex w-11 shrink-0 justify-end sm:w-24">
                    <Switch
                      checked={row.enabled !== false}
                      onCheckedChange={(enabled) =>
                        onToggleEnabled(row.rowId, enabled)
                      }
                      aria-label={t("codexConfig.catalogIncludeModel", {
                        model: row.model,
                        defaultValue: "Include {{model}}",
                      })}
                      title={t(
                        row.enabled !== false
                          ? "catalogBrowser.included"
                          : "catalogBrowser.excluded",
                      )}
                    />
                  </div>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-expanded={open}
                  aria-controls={editorId}
                  aria-label={t("catalogBrowser.editModel", {
                    model: row.model,
                    defaultValue: "Edit {{model}}",
                  })}
                  title={t("catalogBrowser.editModel", {
                    model: row.model,
                    defaultValue: "Edit {{model}}",
                  })}
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
      {selectionToolbar}
    </div>
  );
}
