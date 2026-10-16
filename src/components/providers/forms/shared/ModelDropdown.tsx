import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { FetchedModel } from "@/lib/api/model-fetch";

export function ModelDropdown({
  models,
  onSelect,
}: {
  models: FetchedModel[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const freeFilterId = useId();
  const hasFreeMetadata = models.some(
    (model) => typeof model.isFree === "boolean",
  );
  const confirmedFreeModelCount = models.filter(
    (model) => model.isFree === true,
  ).length;
  const filterFreeModels = freeOnly && hasFreeMetadata;

  // Group models by vendor; missing ownedBy falls back to "Other"
  const grouped: Record<string, FetchedModel[]> = {};
  for (const model of models) {
    if (filterFreeModels && model.isFree !== true) continue;
    const vendor = model.ownedBy || "Other";
    if (!grouped[vendor]) grouped[vendor] = [];
    grouped[vendor].push(model);
  }
  const vendors = Object.keys(grouped).sort();

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={t("providerForm.searchModelAriaLabel", {
            defaultValue: "Select model",
          })}
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className="z-[200] w-72 p-0"
      >
        {hasFreeMetadata && (
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Checkbox
              id={freeFilterId}
              checked={freeOnly}
              onCheckedChange={(checked) => setFreeOnly(checked === true)}
            />
            <label
              htmlFor={freeFilterId}
              className="cursor-pointer text-xs font-medium"
            >
              {t("providerForm.freeModelsOnly", {
                defaultValue: "Free models only",
              })}
            </label>
          </div>
        )}
        <Command
          label={t("providerForm.searchModelPlaceholder", {
            defaultValue: "Search models...",
          })}
        >
          <CommandInput
            placeholder={t("providerForm.searchModelPlaceholder", {
              defaultValue: "Search models...",
            })}
          />
          <CommandList className="max-h-64">
            <CommandEmpty>
              {filterFreeModels &&
              confirmedFreeModelCount === 0 &&
              vendors.length === 0
                ? t("providerForm.noFreeModels", {
                    defaultValue: "No confirmed free models.",
                  })
                : t("providerForm.searchModelEmpty", {
                    defaultValue: "No matching models.",
                  })}
            </CommandEmpty>
            {vendors.map((vendor) => (
              <CommandGroup key={vendor} heading={vendor}>
                {grouped[vendor].map((m) => (
                  <CommandItem
                    key={m.id}
                    value={m.id}
                    // Expose the vendor name as a keyword so models can also be
                    // fuzzy-matched by vendor, not just by model id.
                    keywords={[m.ownedBy || "Other"]}
                    onSelect={() => {
                      onSelect(m.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 break-all">{m.id}</span>
                    {m.isFree === true && (
                      <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground">
                        {t("providerForm.freeModel", {
                          defaultValue: "Free",
                        })}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
