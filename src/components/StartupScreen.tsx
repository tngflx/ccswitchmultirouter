import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import i18n from "@/i18n";
import { Button } from "@/components/ui/button";

export function StartupScreen({ timedOut = false }: { timedOut?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section
        role={timedOut ? "alert" : "status"}
        className="w-full max-w-md space-y-4"
      >
        <div className="flex items-start gap-3">
          {timedOut ? (
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          ) : (
            <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <div className="space-y-2">
            <h1 className="text-base font-semibold">
              {i18n.t(
                timedOut ? "errors.startupTimeoutTitle" : "common.loading",
              )}
            </h1>
            {timedOut && (
              <p className="text-sm leading-6 text-muted-foreground">
                {i18n.t("errors.startupTimeoutMessage")}
              </p>
            )}
          </div>
        </div>
        {timedOut && (
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {i18n.t("errors.reloadInterface")}
          </Button>
        )}
      </section>
    </main>
  );
}
