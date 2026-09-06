import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommandInput, CommandList } from "@/components/ui/command";
import { DeferredRender } from "@/components/common/DeferredContent";

const PAGE_SIZE = 20;

/** Filter before paging; callbacks retain original indices for editing and deletion. */
export function PagedModelList<T>({
  items,
  searchText,
  children,
  command = false,
}: {
  items: readonly T[];
  searchText: (item: T) => string;
  children: (item: T, index: number) => ReactNode;
  command?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [previousLength, setPreviousLength] = useState(items.length);
  if (previousLength !== items.length) {
    setPreviousLength(items.length);
    if (!command && items.length === previousLength + 1) {
      setSearch("");
      setPage(Math.floor((items.length - 1) / PAGE_SIZE));
    }
  }
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) =>
          !query || searchText(item).toLocaleLowerCase().includes(query),
      );
  }, [items, search, searchText]);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const start = currentPage * PAGE_SIZE;
  const changeSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };
  const renderRows = () =>
    filtered
      .slice(start, start + PAGE_SIZE)
      .map(({ item, index }) => children(item, index));
  return (
    <div className="min-w-0 space-y-2">
      {(command || items.length > PAGE_SIZE || search) &&
        (command ? (
          <CommandInput
            autoFocus
            value={search}
            onValueChange={changeSearch}
            placeholder={t("opencode.searchModels")}
            aria-label={t("opencode.searchModels")}
          />
        ) : (
          <Input
            value={search}
            onChange={(event) => changeSearch(event.target.value)}
            placeholder={t("opencode.searchModels")}
            aria-label={t("opencode.searchModels")}
          />
        ))}
      <DeferredRender
        enabled={items.length > PAGE_SIZE}
        render={() =>
          command ? <CommandList>{renderRows()}</CommandList> : renderRows()
        }
      />
      {filtered.length === 0 && (
        <p className="p-2 text-sm text-muted-foreground">
          {t("opencode.noMatchingModels")}
        </p>
      )}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 border-t p-2 text-xs tabular-nums">
          <span aria-live="polite">
            {t("opencode.modelRange", {
              from: start + 1,
              to: Math.min(start + PAGE_SIZE, filtered.length),
              total: filtered.length,
            })}
          </span>
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              aria-label={t("opencode.previousModels")}
              title={t("opencode.previousModels")}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={start + PAGE_SIZE >= filtered.length}
              onClick={() => setPage(currentPage + 1)}
              aria-label={t("opencode.nextModels")}
              title={t("opencode.nextModels")}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
