import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
  commitsBehind?: number;
  compareUrl?: string;
}

export async function checkForUpdate(): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  // Release checks can fail when artifacts are not published yet; still run
  // the source comparison so unreleased commits remain discoverable.
  try {
    const update = await invoke<UpdateInfo | null>("check_app_update");
    if (update) return { status: "available", info: update };
  } catch (error) {
    console.warn(
      "Release update check failed; trying source comparison",
      error,
    );
  }

  // Also check source commits against the ccswitchmulti fork. This catches
  // unreleased fixes and tells maintainers exactly how many commits to cherry-pick.
  const sourceUpdate = await invoke<UpdateInfo | null>(
    "check_github_commits_behind",
  );
  if (sourceUpdate) return { status: "available", info: sourceUpdate };
  return { status: "up-to-date" };
}
