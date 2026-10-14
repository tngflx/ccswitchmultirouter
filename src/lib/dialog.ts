import {
  confirm as tauriConfirm,
  type ConfirmDialogOptions,
} from "@tauri-apps/plugin-dialog";

/**
 * Tauri's dialog plugin is unavailable when the renderer is opened directly
 * in a browser or when an older shell has not registered the command. Keep
 * confirmation actions usable in that environment instead of creating an
 * unhandled rejection.
 */
export async function confirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> {
  try {
    return await tauriConfirm(message, options);
  } catch (error) {
    console.warn(
      "[dialog] Tauri confirm unavailable; using browser fallback",
      error,
    );
    return typeof window !== "undefined" ? window.confirm(message) : false;
  }
}
