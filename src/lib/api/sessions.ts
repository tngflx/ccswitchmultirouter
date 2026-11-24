import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage, SessionMeta } from "@/types";

export interface DeleteSessionOptions {
  providerId: string;
  sessionId: string;
  sourcePath: string;
}

export interface DeleteSessionResult extends DeleteSessionOptions {
  success: boolean;
  error?: string;
}

export interface PurgeArchivedSessionsResult {
  attempted: number;
  deleted: number;
  failed: number;
  indexCleanupWarnings: number;
  errors: string[];
}

export type CodexBackupItem = Pick<
  DeleteSessionOptions,
  "sessionId" | "sourcePath"
>;

export interface CodexBackupPreview {
  manifestHash: string;
  sessions: {
    sessionId: string;
    title: string;
    projectPath?: string | null;
    conflict: boolean;
  }[];
}

export const sessionsApi = {
  async list(): Promise<SessionMeta[]> {
    return await invoke("list_sessions");
  },

  async getMessages(
    providerId: string,
    sourcePath: string,
  ): Promise<SessionMessage[]> {
    return await invoke("get_session_messages", { providerId, sourcePath });
  },

  async delete(options: DeleteSessionOptions): Promise<boolean> {
    const { providerId, sessionId, sourcePath } = options;
    return await invoke("delete_session", {
      providerId,
      sessionId,
      sourcePath,
    });
  },

  async deleteMany(
    items: DeleteSessionOptions[],
  ): Promise<DeleteSessionResult[]> {
    return await invoke("delete_sessions", { items });
  },

  async purgeArchived(
    providerId: string,
  ): Promise<PurgeArchivedSessionsResult> {
    return await invoke("purge_archived_sessions", { providerId });
  },

  async exportCodexBackup(
    targetPath: string,
    items: CodexBackupItem[],
  ): Promise<{ count: number }> {
    return await invoke("export_codex_session_backup", { targetPath, items });
  },

  async inspectCodexBackup(sourcePath: string): Promise<CodexBackupPreview> {
    return await invoke("inspect_codex_session_backup", { sourcePath });
  },

  async importCodexBackup(
    sourcePath: string,
    manifestHash: string,
  ): Promise<{ restored: number; skipped: number }> {
    return await invoke("import_codex_session_backup", {
      sourcePath,
      manifestHash,
    });
  },

  async launchTerminal(options: {
    command: string;
    cwd?: string | null;
    customConfig?: string | null;
  }): Promise<boolean> {
    const { command, cwd, customConfig } = options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
    });
  },
};
