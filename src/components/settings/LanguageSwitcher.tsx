import { useTranslation } from "react-i18next";
import { Check, Languages } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useSaveSettingsMutation, useSettingsQuery } from "@/lib/query";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import type { Settings } from "@/types";

type Language = NonNullable<Settings["language"]>;

const LANGUAGES: Array<{ value: Language; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "ja", label: "日本語" },
];

const normalizeLanguage = (value?: string | null): Language => {
  const normalized = value?.toLowerCase().replace(/_/g, "-");
  if (normalized === "zh-tw" || normalized?.startsWith("zh-hant")) {
    return "zh-TW";
  }
  if (normalized === "ja") return "ja";
  if (normalized === "zh" || normalized?.startsWith("zh")) return "zh";
  return "en";
};

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const { data: settings } = useSettingsQuery();
  const saveMutation = useSaveSettingsMutation();
  const currentLanguage = normalizeLanguage(
    settings?.language ??
      window.localStorage.getItem("language") ??
      i18n.language,
  );
  const currentLabel =
    LANGUAGES.find((language) => language.value === currentLanguage)?.label ??
    "English";

  const changeLanguage = (language: Language) => {
    if (saveMutation.isPending) return;

    void i18n.changeLanguage(language);
    try {
      window.localStorage.setItem("language", language);
    } catch (error) {
      console.warn("[LanguageSwitcher] Failed to persist language", error);
    }

    if (!settings) return;

    saveMutation.mutate(
      {
        ...settings,
        showInTray: settings.showInTray ?? true,
        minimizeToTrayOnClose: settings.minimizeToTrayOnClose ?? true,
        language,
      },
      {
        onError: (error) => {
          toast.error(`Failed to save language: ${extractErrorMessage(error)}`);
        },
      },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={saveMutation.isPending}
          title="Language"
          className="gap-1.5 px-2 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Languages className="h-4 w-4" />
          <span className="hidden text-xs sm:inline">{currentLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((language) => (
          <DropdownMenuItem
            key={language.value}
            onSelect={() => changeLanguage(language.value)}
            className={cn(language.value === currentLanguage && "bg-accent/50")}
          >
            <Check
              className={cn(
                "mr-1 h-4 w-4",
                language.value === currentLanguage
                  ? "opacity-100"
                  : "opacity-0",
              )}
            />
            {language.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
