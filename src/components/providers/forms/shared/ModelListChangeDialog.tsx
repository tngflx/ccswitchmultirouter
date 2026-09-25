import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ModelListChange {
  added: string[];
  removed: string[];
  updated: string[];
}

export function ModelListChangeDialog({
  change,
  onClose,
}: {
  change: ModelListChange | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={Boolean(change)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("codexConfig.modelListChangedTitle")}</DialogTitle>
          <DialogDescription>
            {t("codexConfig.modelListChangedDescription")}
          </DialogDescription>
        </DialogHeader>
        {change && (
          <div className="space-y-3 px-6 pb-2 text-sm">
            {(
              [
                ["added", "text-emerald-600 dark:text-emerald-400"],
                ["removed", "text-destructive"],
                ["updated", "text-blue-600 dark:text-blue-400"],
              ] as const
            ).map(([kind, color]) =>
              change[kind].length > 0 ? (
                <div key={kind}>
                  <p className={`font-medium ${color}`}>
                    {t(
                      `codexConfig.modelList${kind[0].toUpperCase()}${kind.slice(1)}`,
                      {
                        count: change[kind].length,
                      },
                    )}
                  </p>
                  <p className="mt-1 max-h-24 overflow-y-auto break-words font-mono text-xs text-muted-foreground">
                    {change[kind].join(", ")}
                  </p>
                </div>
              ) : null,
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("codexConfig.modelListDismiss")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
