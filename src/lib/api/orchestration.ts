import { invoke } from "@tauri-apps/api/core";
import type {
  OrchestrationEvent,
  OrchestrationProfile,
  OrchestrationRun,
  OrchestrationSettings,
} from "@/types";
import type { CodexRoutingProjectionStatus } from "./providers";

export interface OrchestrationSaveResult {
  settings: OrchestrationSettings;
  codexProjection: CodexRoutingProjectionStatus | null;
  publicationError: string | null;
}

export const orchestrationApi = {
  getSettings: () =>
    invoke<OrchestrationSettings>("get_orchestration_settings"),
  saveSettings: (settings: OrchestrationSettings) =>
    invoke<OrchestrationSaveResult>("save_orchestration_settings", {
      settings,
    }),
  listRuns: () => invoke<OrchestrationRun[]>("list_orchestration_runs"),
  cancelRun: (runId: string) =>
    invoke<boolean>("cancel_orchestration_run", { runId }),
};

export type {
  OrchestrationEvent,
  OrchestrationProfile,
  OrchestrationRun,
  OrchestrationSettings,
};
