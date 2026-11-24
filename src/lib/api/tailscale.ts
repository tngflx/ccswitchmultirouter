import { invoke } from "@tauri-apps/api/core";

export type TailscaleState =
  | "missing"
  | "needsLogin"
  | "needsApproval"
  | "serveMissing"
  | "targetMismatch"
  | "originMismatch"
  | "ready"
  | "reachable"
  | "unreachable"
  | "error";

export interface TailscaleStatus {
  state: TailscaleState;
  executablePath?: string | null;
  version?: string | null;
  backendState?: string | null;
  serveTarget?: string | null;
  origin?: string | null;
  reachable: boolean;
  error?: string | null;
}

export const tailscaleApi = {
  getStatus: (): Promise<TailscaleStatus> => invoke("get_tailscale_status"),
  connect: (): Promise<TailscaleStatus> =>
    invoke("connect_tailscale_owner_remote"),
  verifyOwnerRemote: (): Promise<TailscaleStatus> =>
    invoke("verify_tailscale_owner_remote"),
};
