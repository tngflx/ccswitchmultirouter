import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useIsMutating } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface GlobalLoadingContextValue {
  beginLoading: (label?: string) => () => void;
  runWithLoading: <T>(task: () => Promise<T>, label?: string) => Promise<T>;
}

const GlobalLoadingContext = createContext<GlobalLoadingContextValue>({
  beginLoading: () => () => {},
  runWithLoading: (task) => task(),
});

export function useGlobalLoading(): GlobalLoadingContextValue {
  return useContext(GlobalLoadingContext);
}

export function GlobalLoadingProvider({
  children,
  delayMs = 300,
}: {
  children: ReactNode;
  delayMs?: number;
}) {
  const { t } = useTranslation();
  const nextTaskId = useRef(0);
  const [manualTasks, setManualTasks] = useState<
    Map<number, string | undefined>
  >(() => new Map());
  const mutatingCount = useIsMutating({
    predicate: (mutation) => mutation.options.meta?.showGlobalLoading !== false,
  });

  const beginLoading = useCallback((label?: string) => {
    const taskId = nextTaskId.current++;
    setManualTasks((current) => new Map(current).set(taskId, label));
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      setManualTasks((current) => {
        const next = new Map(current);
        next.delete(taskId);
        return next;
      });
    };
  }, []);

  const runWithLoading = useCallback(
    async <T,>(task: () => Promise<T>, label?: string): Promise<T> => {
      const finish = beginLoading(label);
      try {
        return await task();
      } finally {
        finish();
      }
    },
    [beginLoading],
  );

  const active = manualTasks.size > 0 || mutatingCount > 0;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);

  const label = Array.from(manualTasks.values()).reverse().find(Boolean);
  const value = useMemo(
    () => ({ beginLoading, runWithLoading }),
    [beginLoading, runWithLoading],
  );

  return (
    <GlobalLoadingContext.Provider value={value}>
      {children}
      {visible && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed left-1/2 top-3 z-[220] flex -translate-x-1/2 items-center gap-2 rounded-md border border-border-default bg-popover px-3 py-2 text-sm font-medium text-popover-foreground shadow-lg"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{label || t("common.loading")}</span>
        </div>
      )}
    </GlobalLoadingContext.Provider>
  );
}
