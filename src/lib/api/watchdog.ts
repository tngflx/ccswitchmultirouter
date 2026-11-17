import { invoke } from "@tauri-apps/api/core";

/** 看门狗日志里的一条事件。 */
export interface WatchdogEventRecord {
  timestamp: string;
  level: string;
  event: string;
  detail?: unknown;
}

/** 设置页“看门狗与端口自检”面板的数据。 */
export interface WatchdogStatus {
  /** Effective recovery policy for the current owner. */
  enabled: boolean;
  /** Saved switch; optional while an older native process is still running. */
  configuredEnabled?: boolean;
  /** Explicit pnpm-dev environment policy, not another persisted setting. */
  enabledOverride?: boolean | null;
  supervisorMode?: "rust" | "pnpm-dev";
  appPid: number;
  supervisorPid?: number | null;
  supervisorAlive: boolean;
  supervisorPath?: string | null;
  restartsInWindow: number;
  port: number;
  listenerPid?: number | null;
  listenerPath?: string | null;
  portReady: boolean;
  portDiagnosis: string;
  recentEvents: WatchdogEventRecord[];
}

export const watchdogApi = {
  async getStatus(): Promise<WatchdogStatus> {
    return await invoke("get_watchdog_status");
  },
};
