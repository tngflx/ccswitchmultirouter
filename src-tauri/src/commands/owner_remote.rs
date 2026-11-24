//! Host-local setup only. Browser control is authenticated by the separate
//! owner service; never expose a direct Tauri continuation or arbitrary CDP RPC.

pub use crate::services::owner_remote::{OwnerInvite, OwnerRemoteStatus};
use crate::store::AppState;

#[tauri::command]
pub async fn get_owner_remote_status(
    state: tauri::State<'_, AppState>,
) -> Result<OwnerRemoteStatus, String> {
    Ok(state.owner_remote.status().await)
}

#[tauri::command]
pub async fn start_owner_remote(
    state: tauri::State<'_, AppState>,
    https_origin: String,
) -> Result<OwnerRemoteStatus, String> {
    let _setup = super::tailscale::OWNER_REMOTE_SETUP
        .try_lock()
        .map_err(|_| "tailscale_setup_in_progress".to_owned())?;
    state
        .owner_remote
        .start(&https_origin)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stop_owner_remote(
    state: tauri::State<'_, AppState>,
) -> Result<OwnerRemoteStatus, String> {
    let _setup = super::tailscale::OWNER_REMOTE_SETUP
        .try_lock()
        .map_err(|_| "tailscale_setup_in_progress".to_owned())?;
    state
        .owner_remote
        .stop()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_owner_remote_invite(
    state: tauri::State<'_, AppState>,
) -> Result<OwnerInvite, String> {
    state
        .owner_remote
        .create_local_invite()
        .await
        .map_err(|error| error.to_string())
}
