import { useEffect, useSyncExternalStore } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StreamRetryActivity } from "@/types/proxy";

const MAX_ACTIVITY_ITEMS = 50;

let snapshot: StreamRetryActivity[] = [];
const subscribers = new Set<() => void>();

function isStreamRetryActivity(value: unknown): value is StreamRetryActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Partial<StreamRetryActivity>;
  return (
    typeof activity.timestamp === "string" &&
    typeof activity.stage === "string" &&
    typeof activity.event === "string" &&
    Number.isInteger(activity.attempt) &&
    (activity.maxAttempts === null || Number.isInteger(activity.maxAttempts)) &&
    typeof activity.sessionId === "string" &&
    typeof activity.model === "string" &&
    typeof activity.providerId === "string" &&
    (activity.reasonClass === null || typeof activity.reasonClass === "string")
  );
}

function publish(activity: StreamRetryActivity) {
  snapshot = [activity, ...snapshot].slice(0, MAX_ACTIVITY_ITEMS);
  subscribers.forEach((subscriber) => subscriber());
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function getSnapshot() {
  return snapshot;
}

/**
 * Keep the retry feed subscribed at the app boundary so events are not lost
 * while the user is still on the provider page.
 */
export function useStreamRetryActivityBridge() {
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<unknown>("stream-retry-activity", ({ payload }) => {
      if (!disposed && isStreamRetryActivity(payload)) {
        publish(payload);
      }
    })
      .then((off) => {
        if (disposed) {
          off();
        } else {
          unlisten = off;
        }
      })
      .catch((error) => {
        console.debug(
          "[stream-retry-activity] Failed to subscribe to retry activity",
          error,
        );
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

export function useStreamRetryActivity(): StreamRetryActivity[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
