import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGlobalLoading } from "@/contexts/GlobalLoadingContext";

const DEFERRED_PAINT_FALLBACK_MS = 100;

function scheduleAfterPaint(callback: () => void): () => void {
  let settled = false;
  let frame: number | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let callbackTimer: ReturnType<typeof setTimeout> | undefined;
  const complete = () => {
    if (settled) return;
    settled = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(fallbackTimer);
    callbackTimer = setTimeout(callback, 0);
  };
  frame = requestAnimationFrame(complete);
  fallbackTimer = setTimeout(complete, DEFERRED_PAINT_FALLBACK_MS);
  return () => {
    settled = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(fallbackTimer);
    clearTimeout(callbackTimer);
  };
}

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
    const cancelReady = scheduleAfterPaint(() => {
      setReady(true);
      finishGlobalLoading();
    });
    return () => {
      cancelReady();
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
    const cancelReady = scheduleAfterPaint(() => {
      setReady(true);
      finishGlobalLoading();
    });
    return () => {
      cancelReady();
      finishGlobalLoading();
    };
  }, [beginLoading, enabled]);
  return ready ? render() : <LoadingStatus />;
}
