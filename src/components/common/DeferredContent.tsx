import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGlobalLoading } from "@/contexts/GlobalLoadingContext";

export function LoadingStatus() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-16 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      {t("common.loading")}
    </div>
  );
}

/** Commit the shell, then allow a browser paint before mounting expensive editors. */
export function DeferredContent({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const { beginLoading } = useGlobalLoading();
  useEffect(() => {
    const finishGlobalLoading = beginLoading();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setReady(true), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      finishGlobalLoading();
    };
  }, [beginLoading]);
  return ready ? children : <LoadingStatus />;
}

/** Defer construction as well as mounting, so large child trees cannot block the loading paint. */
export function DeferredRender({
  render,
  enabled = true,
}: {
  render: () => ReactNode;
  enabled?: boolean;
}) {
  const [ready, setReady] = useState(!enabled);
  const { beginLoading } = useGlobalLoading();
  useEffect(() => {
    if (!enabled) {
      setReady(true);
      return;
    }
    const finishGlobalLoading = beginLoading();
    setReady(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setReady(true), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      finishGlobalLoading();
    };
  }, [beginLoading, enabled]);
  return ready ? render() : <LoadingStatus />;
}
