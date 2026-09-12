import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandItem } from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PagedModelList } from "./PagedModelList";
import type { FetchedModel } from "@/lib/api/model-fetch";

const searchText = (model: FetchedModel) =>
  `${model.id} ${model.ownedBy || ""}`;

export function ModelDropdown({
  models,
  onSelect,
  label,
  getLabel = (id) => id,
}: {
  models: FetchedModel[];
  onSelect: (id: string) => void;
  label?: string;
  getLabel?: (id: string) => string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ordered = useMemo(
    () =>
      open
        ? [...models].sort((a, b) =>
            (a.ownedBy || "").localeCompare(b.ownedBy || ""),
          )
        : [],
    [models, open],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={label ? "sm" : "icon"}
          className="shrink-0 max-w-48 gap-2"
          aria-label={label ?? t("omo.selectModel")}
          title={label ?? t("omo.selectModel")}
        >
          {label && <span className="truncate">{label}</span>}
          <ChevronDown className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      {open && (
        <PopoverContent
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] p-0"
        >
          <Command shouldFilter={false}>
            <PagedModelList
              items={ordered}
              searchText={(model) =>
                `${searchText(model)} ${getLabel(model.id)}`
              }
              command
            >
              {(model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  className="min-w-0 break-all"
                  onSelect={() => {
                    onSelect(model.id);
                    setOpen(false);
                  }}
                >
                  <span>
                    {getLabel(model.id)}
                    {model.ownedBy && (
                      <span className="block text-xs text-muted-foreground">
                        {model.ownedBy}
                      </span>
                    )}
                  </span>
                </CommandItem>
              )}
            </PagedModelList>
          </Command>
        </PopoverContent>
      )}
    </Popover>
  );
}
