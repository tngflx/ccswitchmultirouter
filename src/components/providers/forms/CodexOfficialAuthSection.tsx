import { ExternalLink, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import type { CodexOfficialAuthConfig, CodexOfficialAuthMode } from "@/types";

export function validateCodexOfficialAuthSelection(
  value: CodexOfficialAuthConfig,
  accounts: ManagedAuthAccount[],
): string | null {
  if (value.mode !== "managed_oauth") return null;
  const accountId = value.accountId?.trim();
  return accounts.some(
    (account) => account.id === accountId && !account.requires_reauth,
  )
    ? null
    : "The selected CCSM OAuth account is unavailable or needs reauthentication";
}

export function CodexOfficialAuthSection({
  value,
  accounts,
  onChange,
  onOpenAuthCenter,
}: {
  value: CodexOfficialAuthConfig;
  accounts: ManagedAuthAccount[];
  onChange: (value: CodexOfficialAuthConfig) => void;
  onOpenAuthCenter: () => void;
}) {
  const { t } = useTranslation();
  const usable = accounts.filter((account) => !account.requires_reauth);
  const validationError = validateCodexOfficialAuthSelection(value, accounts);
  const changeMode = (mode: CodexOfficialAuthMode) => {
    if (mode !== "managed_oauth") return onChange({ mode });
    const account =
      usable.find((item) => item.id === value.accountId) ??
      usable.find((item) => item.is_default) ??
      usable[0];
    onChange({ mode, ...(account ? { accountId: account.id } : {}) });
  };

  return (
    <section className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-800/60 dark:bg-blue-950/20">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 text-blue-600 dark:text-blue-400" />
        <div>
          <h3 className="font-semibold">
            {t("codexOfficialAuth.title", "OpenAI Official authentication")}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t(
              "codexOfficialAuth.description",
              "Official model authentication is configured here and shared with official MultiRouter routes.",
            )}
          </p>
        </div>
      </div>
      <label className="grid gap-2 text-sm font-medium">
        {t("codexOfficialAuth.modeLabel", "Authentication mode")}
        <select
          aria-label={t("codexOfficialAuth.modeLabel", "Authentication mode")}
          value={value.mode}
          onChange={(event) =>
            changeMode(event.target.value as CodexOfficialAuthMode)
          }
          className="h-10 rounded-md border bg-background px-3 text-sm"
        >
          <option value="desktop_current_login">
            {t("codexOfficialAuth.desktopOption", "Codex Desktop current login")}
          </option>
          <option value="managed_oauth">
            {t("codexOfficialAuth.managedOption", "CCSM OAuth account")}
          </option>
          <option value="account_pool">
            {t("codexOfficialAuth.poolOption", "OAuth account pool")}
          </option>
        </select>
      </label>
      {value.mode === "managed_oauth" && (
        <label className="grid gap-2 text-sm font-medium">
          {t("codexOfficialAuth.managedAccountLabel", "CCSM OAuth account")}
          <select
            aria-label={t(
              "codexOfficialAuth.managedAccountLabel",
              "CCSM OAuth account",
            )}
            value={value.accountId ?? ""}
            onChange={(event) =>
              onChange({ mode: "managed_oauth", accountId: event.target.value })
            }
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            <option value="" disabled>
              {t("codexOfficialAuth.selectAccount", "Select a signed-in account")}
            </option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id} disabled={account.requires_reauth}>
                {account.login}
                {account.requires_reauth ? " (reauth required)" : ""}
              </option>
            ))}
          </select>
          {validationError && (
            <span className="text-xs text-red-600 dark:text-red-400">
              {validationError}
            </span>
          )}
        </label>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background/70 p-3">
        <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
          {t(
            "codexOfficialAuth.authCenterHint",
            "Sign-in and account-pool membership are managed in the authentication center. This section stores only a non-secret account reference.",
          )}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onOpenAuthCenter}>
          {t("codexOfficialAuth.openAuthCenter", "Open authentication center")}
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}
