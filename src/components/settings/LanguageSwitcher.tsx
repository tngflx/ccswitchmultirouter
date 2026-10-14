import { Check, Languages } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { normalizeLanguage, type SupportedLanguage } from "@/i18n/language";
import { useSettingsQuery } from "@/lib/query";
import { settingsApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";

const LANGUAGES: Array<{
  value: SupportedLanguage;
  labelKey:
    | "settings.languageOptionEnglish"
    | "settings.languageOptionChinese"
    | "settings.languageOptionTraditionalChinese"
    | "settings.languageOptionJapanese";
}> = [
  { value: "en", labelKey: "settings.languageOptionEnglish" },
  { value: "zh", labelKey: "settings.languageOptionChinese" },
  {
    value: "zh-TW",
    labelKey: "settings.languageOptionTraditionalChinese",
  },
  { value: "ja", labelKey: "settings.languageOptionJapanese" },
];

function readStoredLanguage(): string | null {
  try {
    return window.localStorage.getItem("language");
  } catch (error) {
    console.warn(
      "[LanguageSwitcher] Failed to read language preference",
      error,
    );
    return null;
  }
}

function writeStoredLanguage(value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem("language");
    } else {
      window.localStorage.setItem("language", value);
    }
  } catch (error) {
    console.warn("[LanguageSwitcher] Failed to persist language", error);
  }
}

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const { data: settings } = useSettingsQuery();
  const [isSaving, setIsSaving] = useState(false);
  const [selectedLanguage, setSelectedLanguage] =
    useState<SupportedLanguage | null>(null);
  const currentLanguage =
    selectedLanguage ??
    normalizeLanguage(
      settings?.language ??
        readStoredLanguage() ??
        i18n.resolvedLanguage ??
        i18n.language,
    );
  const currentLabel = t(
    LANGUAGES.find(({ value }) => value === currentLanguage)?.labelKey ??
      "settings.languageOptionEnglish",
  );

  const changeLanguage = (language: SupportedLanguage) => {
    if (isSaving || language === currentLanguage) return;

    const previousLanguage = currentLanguage;
    const previousStoredLanguage = readStoredLanguage();

    setSelectedLanguage(language);
    void i18n.changeLanguage(language);
    writeStoredLanguage(language);

    if (!settings) return;

    setIsSaving(true);
    void settingsApi
      .patch({ language })
      .catch((error) => {
        setSelectedLanguage(previousLanguage);
        void i18n.changeLanguage(previousLanguage);
        writeStoredLanguage(previousStoredLanguage);
        toast.error(t("settings.saveFailedGeneric"), {
          description: extractErrorMessage(error),
        });
      })
      .finally(() => setIsSaving(false));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={isSaving}
          title={t("settings.language")}
          aria-label={t("settings.language")}
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
            {t(language.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
