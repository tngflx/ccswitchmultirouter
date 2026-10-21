import type { QueryClient } from "@tanstack/react-query";
import { settingsApi } from "@/lib/api";
import type { Settings } from "@/types";

export type StreamRetryMode = "off" | "safe" | "aggressive";

export const STREAM_RETRY_SETTING_KEYS = [
  "enableStreamRetry",
  "streamRetryMode",
  "streamRetryMaxAttempts",
] as const;

export type StreamRetrySettingsPatch = Partial<
  Pick<Settings, (typeof STREAM_RETRY_SETTING_KEYS)[number]>
>;

export const resolveStreamRetryMode = (
  mode: Settings["streamRetryMode"],
  legacyEnabled: boolean | undefined,
): StreamRetryMode => {
  if (legacyEnabled === false && (mode === undefined || mode === "safe")) {
    return "off";
  }
  return mode ?? "safe";
};

export const clampStreamRetryMaxAttempts = (value?: number): number =>
  Math.min(3, Math.max(1, value ?? 3));

export const streamRetryModePatch = (
  mode: StreamRetryMode,
): StreamRetrySettingsPatch => ({
  streamRetryMode: mode,
  enableStreamRetry: mode !== "off",
});

/** Persist the canonical retry patch and refresh the shared settings cache. */
export async function persistStreamRetryPatch(
  queryClient: QueryClient,
  patch: StreamRetrySettingsPatch,
): Promise<Settings> {
  await settingsApi.patch(patch);
  await queryClient.cancelQueries({ queryKey: ["settings"] });
  const canonical = await settingsApi.get();
  queryClient.setQueryData(["settings"], canonical);
  return canonical;
}
