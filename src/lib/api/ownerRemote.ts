import { invoke } from "@tauri-apps/api/core";

export interface OwnerRemoteStatus {
  enabled: boolean;
  running: boolean;
  httpsOrigin?: string | null;
  loopbackAddress: string;
  hostId?: string | null;
  error?: string | null;
}

export interface OwnerRemoteInvite {
  invitationSecret: string;
  expiresInSeconds: number;
}

/** Host-local setup. There is deliberately no renderer/raw-RPC submit method. */
export const ownerRemoteApi = {
  getStatus: (): Promise<OwnerRemoteStatus> =>
    invoke("get_owner_remote_status"),
  start: (httpsOrigin: string): Promise<OwnerRemoteStatus> =>
    invoke("start_owner_remote", { httpsOrigin }),
  stop: (): Promise<OwnerRemoteStatus> => invoke("stop_owner_remote"),
  createInvite: (): Promise<OwnerRemoteInvite> =>
    invoke("create_owner_remote_invite"),
};
