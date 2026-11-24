use crate::{
    commands::run_command_blocking,
    services::{
        owner_remote::OwnerRemoteStatus,
        tailscale::{self, NodeStatus, TailscaleClient, TailscaleState, TailscaleStatus},
    },
    store::AppState,
};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;

pub(super) static OWNER_REMOTE_SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn get_tailscale_status(
    state: tauri::State<'_, AppState>,
) -> Result<TailscaleStatus, String> {
    inspect(state.owner_remote.status().await).await
}

#[tauri::command]
pub async fn connect_tailscale_owner_remote(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TailscaleStatus, String> {
    let _setup = OWNER_REMOTE_SETUP
        .try_lock()
        .map_err(|_| "tailscale_setup_in_progress".to_owned())?;

    let client = run_command_blocking(|| {
        Ok(TailscaleClient::discover().map_or_else(TailscaleClient::install, Ok))
    })
    .await?;
    let client = match client {
        Ok(client) => client,
        Err(code) => return Ok(TailscaleStatus::new(TailscaleState::Missing).fail(code)),
    };
    let node = read_node(&client).await?;
    let mut node = match node {
        Ok(node) => node,
        Err(code) => return Ok(TailscaleStatus::new(TailscaleState::Error).fail(code)),
    };
    if node.needs_connection() {
        let cli = client.clone();
        let login = run_command_blocking(move || Ok(cli.begin_login())).await?;
        let (initial, url) = match login {
            Ok(login) => login,
            Err(code) => return Ok(node.status().fail(code)),
        };
        if let Some(url) = url {
            if app.opener().open_url(url.as_str(), None::<String>).is_err() {
                return Ok(initial.status().fail("tailscale_login_failed"));
            }
        }
        node = wait_for_login(&client, initial).await?;
        if node.needs_connection() {
            return Ok(node.status().fail("tailscale_login_timeout"));
        }
    }

    let owner = state.owner_remote.status().await;
    let cli = client.clone();
    let status = run_command_blocking(move || Ok(cli.inspect_node(&node, &owner))).await?;
    if !matches!(
        status.state,
        TailscaleState::ServeMissing | TailscaleState::Ready
    ) {
        return Ok(status);
    }
    let Some(origin) = status.origin.as_deref() else {
        return Ok(status.fail("tailscale_command_failed"));
    };

    // Claim the fixed loopback listener before pointing Serve at the port.
    let owner = match state.owner_remote.start(origin).await {
        Ok(owner) => owner,
        Err(_) => return Ok(status.fail("tailscale_owner_remote_start_failed")),
    };
    let current = owner.clone();
    let status = run_command_blocking(move || {
        Ok(client.configure_serve(&current, move |url| {
            app.opener()
                .open_url(url.as_str(), None::<String>)
                .map_err(|_| "tailscale_serve_failed")
        }))
    })
    .await?;
    Ok(tailscale::verify(status, &owner, 3).await)
}

#[tauri::command]
pub async fn verify_tailscale_owner_remote(
    state: tauri::State<'_, AppState>,
) -> Result<TailscaleStatus, String> {
    let _setup = OWNER_REMOTE_SETUP
        .try_lock()
        .map_err(|_| "tailscale_setup_in_progress".to_owned())?;
    let owner = state.owner_remote.status().await;
    let status = inspect(owner.clone()).await?;
    Ok(tailscale::verify(status, &owner, 1).await)
}

async fn inspect(owner: OwnerRemoteStatus) -> Result<TailscaleStatus, String> {
    run_command_blocking(move || {
        Ok(TailscaleClient::discover()
            .map(|client| client.inspect(&owner))
            .unwrap_or_else(|| TailscaleStatus::new(TailscaleState::Missing)))
    })
    .await
}

async fn read_node(client: &TailscaleClient) -> Result<Result<NodeStatus, &'static str>, String> {
    let cli = client.clone();
    run_command_blocking(move || Ok(cli.node_status())).await
}

async fn wait_for_login(
    client: &TailscaleClient,
    mut node: NodeStatus,
) -> Result<NodeStatus, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    while node.needs_connection() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Ok(next) = read_node(client).await? {
            node = next;
        }
    }
    Ok(node)
}
