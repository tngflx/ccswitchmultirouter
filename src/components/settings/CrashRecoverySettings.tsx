import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SettingsFormState } from "@/hooks/useSettings";
import { ToggleRow } from "@/components/ui/toggle-row";
import { WatchdogStatusPanel } from "./WatchdogStatusPanel";

type SaveCrashRecoverySetting = (
  updates: Partial<SettingsFormState>,
) => Promise<boolean>;

export interface CrashRecoveryController {
  saving: boolean;
  saveFailed: boolean;
  refreshVersion: number;
  changeEnabled: (watchdogEnabled: boolean) => Promise<void>;
}

/** Own operation lifetime above tab content; never copy the persisted setting. */
export function useCrashRecoveryController(
  onChange: SaveCrashRecoverySetting,
): CrashRecoveryController {
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const changeEnabled = async (watchdogEnabled: boolean) => {
    // Guard synchronously too: multiple input events can precede the next render.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      const saved = await onChange({ watchdogEnabled });
      if (!mountedRef.current) return;
      if (saved === true) {
        // Do not fetch on the optimistic form change: it may precede persistence.
        setRefreshVersion((version) => version + 1);
      } else {
        setSaveFailed(true);
      }
    } catch {
      // A native exception may carry sensitive data. Show only localized copy.
      if (mountedRef.current) setSaveFailed(true);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return { saving, saveFailed, refreshVersion, changeEnabled };
}

interface CrashRecoverySettingsProps {
  settings: SettingsFormState;
  controller: CrashRecoveryController;
}

/** The switch uses the existing settings store; status remains native evidence. */
export function CrashRecoverySettings({
  settings,
  controller,
}: CrashRecoverySettingsProps) {
  const { t } = useTranslation();
  const { saving, saveFailed, refreshVersion, changeEnabled } = controller;

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium">
        {t("settings.crashRecoveryTitle")}
      </h3>
      <ToggleRow
        icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
        title={t("settings.watchdogEnabled")}
        description={t("settings.watchdogEnabledDescription")}
        checked={settings.watchdogEnabled !== false}
        onCheckedChange={(value) => void changeEnabled(value)}
        disabled={saving}
      />
      <p className="text-xs text-muted-foreground">
        {t("settings.crashRecoveryIndependent")}
      </p>
      {saving ? (
        <p
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t("settings.crashRecoverySaving")}
        </p>
      ) : null}
      {saveFailed ? (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.crashRecoverySaveFailed")}
        </p>
      ) : null}
      <details className="rounded-md border border-border/40 px-3 py-2 text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground">
          {t("settings.crashRecoveryWhenTitle")}
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
          <li>{t("settings.crashRecoveryUnexpected")}</li>
          <li>{t("settings.crashRecoveryManualQuit")}</li>
          <li>{t("settings.crashRecoveryRateLimit")}</li>
          <li>{t("settings.crashRecoveryDevOutput")}</li>
        </ul>
      </details>
      <WatchdogStatusPanel refreshVersion={refreshVersion} />
    </section>
  );
}
