use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex};

use crate::codex_desktop::{
    candidate_debug_ports, codex_renderer_compatibility_is_current,
    detect_running_codex_main_process, list_cdp_targets, load_cc_switch_model_catalog_projection,
    pick_codex_page_targets, try_inject_on_candidate_ports, CodexModelCatalogProjection,
    DEFAULT_CODEX_DEBUG_PORT,
};

const GUARDIAN_CHECK_INTERVAL: Duration = Duration::from_secs(3);

/// 守护上报给前端的即时状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexGuardianStatus {
    pub active: bool,
    pub codex_running: bool,
    pub cdp_available: bool,
    pub injected_target_count: usize,
    pub injected: bool,
    pub last_event: String,
    pub message: String,
}

/// 守护内部持有的可变更状态。
struct GuardianInner {
    injected_target_ids: Vec<String>,
    injected_catalog_fingerprint: Option<String>,
    inject_generation: u64,
}

/// 守护的外部句柄；丢弃后守护自动停止。
pub(crate) struct GuardianHandle {
    shutdown_tx: watch::Sender<bool>,
    pub(crate) status: Arc<Mutex<CodexGuardianStatus>>,
}

/// 启动 Codex 桌面模型菜单生命周期守护。
///
/// 守护不会静默终止正在工作的 Codex。
/// 在检测到新 renderer target、目录变化或 renderer 重载时幂等重新注入；
/// 若 CDP 不可用则记录原因并等待。
pub(crate) fn start_codex_guardian() -> GuardianHandle {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let status = Arc::new(Mutex::new(CodexGuardianStatus {
        active: true,
        codex_running: false,
        cdp_available: false,
        injected_target_count: 0,
        injected: false,
        last_event: "守护已启动".into(),
        message: "守护已启动，等待 Codex Desktop...".into(),
    }));

    let inner = Arc::new(Mutex::new(GuardianInner {
        injected_target_ids: Vec::new(),
        injected_catalog_fingerprint: None,
        inject_generation: 0,
    }));

    let s = status.clone();
    let i = inner.clone();
    tokio::spawn(async move {
        guardian_loop(s, i, shutdown_rx).await;
    });

    GuardianHandle {
        shutdown_tx,
        status,
    }
}

impl GuardianHandle {
    pub(crate) fn stop(self) {
        let _ = self.shutdown_tx.send(true);
    }
}

async fn guardian_loop(
    status: Arc<Mutex<CodexGuardianStatus>>,
    inner: Arc<Mutex<GuardianInner>>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if *shutdown.borrow() {
            let mut s = status.lock().await;
            s.active = false;
            s.last_event = "守护已停止".into();
            s.message = "守护已停止".into();
            return;
        }

        run_guardian_cycle(&status, &inner).await;

        tokio::select! {
            _ = tokio::time::sleep(GUARDIAN_CHECK_INTERVAL) => {},
            _ = shutdown.changed() => {
                let mut s = status.lock().await;
                s.active = false;
                s.last_event = "守护已停止".into();
                s.message = "守护已停止".into();
                return;
            }
        }
    }
}

async fn run_guardian_cycle(
    status: &Arc<Mutex<CodexGuardianStatus>>,
    inner: &Arc<Mutex<GuardianInner>>,
) {
    // 1. 检查 Codex 主进程是否在运行。
    let running = detect_running_codex_main_process();
    if running.is_none() {
        let mut s = status.lock().await;
        s.codex_running = false;
        s.cdp_available = false;
        s.injected = false;
        s.injected_target_count = 0;
        s.last_event = "Codex 未运行".into();
        s.message = "Codex Desktop 未运行，等待用户启动...".into();
        // 进程消失时清理已知 target，下次启动不会跳过新 target。
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        return;
    }

    // 2. 保留 websocket 地址，以便同一 target 重载后核验 renderer 状态。
    let ports = candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT);
    let mut current_targets: Vec<(String, String)> = Vec::new();
    let mut target_ports = Vec::new();
    let mut cdp_available = false;

    for port in &ports {
        match list_cdp_targets(*port).await {
            Ok(targets) => match pick_codex_page_targets(&targets, *port) {
                Ok(pages) => {
                    cdp_available = true;
                    target_ports.push(*port);
                    for t in &pages {
                        if let Some(websocket_url) = t.web_socket_debugger_url.as_deref() {
                            if !current_targets.iter().any(|(id, _)| id == &t.id) {
                                current_targets.push((t.id.clone(), websocket_url.to_string()));
                            }
                        }
                    }
                }
                Err(_) => continue,
            },
            Err(_) => continue,
        }
    }

    if !cdp_available {
        let mut s = status.lock().await;
        s.codex_running = true;
        s.cdp_available = false;
        s.injected = false;
        s.injected_target_count = 0;
        s.last_event = "Codex 运行中但无 CDP".into();
        s.message = "Codex Desktop 正在运行但未开放 CDP 调试端口；CCSM 不会静默终止 Codex，请退出后从 CCSM 启动或等待下次 CCSM 启动 Codex 时自动注入。".into();
        let mut guard = inner.lock().await;
        guard.injected_target_ids.clear();
        guard.injected_catalog_fingerprint = None;
        return;
    }

    // 3. 同时比较 target 和目录。renderer 补丁持有模型目录状态，因此 Provider
    // 目录变化时，即使 target ID 不变也必须重新注入。
    let catalog = match load_cc_switch_model_catalog_projection() {
        Ok(catalog) => catalog,
        Err(error) => {
            let mut s = status.lock().await;
            s.codex_running = true;
            s.cdp_available = true;
            s.last_event = "模型目录加载失败".into();
            s.message = format!("无法加载 CCSM 模型目录: {error}");
            log::warn!("Codex 守护: 模型目录加载失败: {error}");
            return;
        }
    };
    let catalog_fingerprint = catalog.fingerprint();
    let mut guard = inner.lock().await;
    guard.injected_target_ids.retain(|id| {
        current_targets
            .iter()
            .any(|(current_id, _)| current_id == id)
    });
    let new_ids: Vec<String> = current_targets
        .iter()
        .filter(|(id, _)| !guard.injected_target_ids.contains(id))
        .map(|(id, _)| id.clone())
        .collect();
    let injected_catalog_fingerprint = guard.injected_catalog_fingerprint.clone();
    let catalog_changed =
        injected_catalog_fingerprint.as_deref() != Some(catalog_fingerprint.as_str());
    drop(guard);

    // New-document CDP scripts belong to the installing connection. Its socket
    // is short-lived, so an unchanged target ID cannot prove a reloaded page is
    // still patched. Check every current renderer before reporting it healthy.
    let verified_target_ids = if new_ids.is_empty() && !catalog_changed {
        current_renderer_target_ids(&current_targets, &catalog).await
    } else {
        Vec::new()
    };
    let renderers_current = verified_target_ids.len() == current_targets.len();

    if !guardian_should_inject(
        &new_ids,
        injected_catalog_fingerprint.as_deref(),
        &catalog_fingerprint,
        renderers_current,
    ) {
        let mut guard = inner.lock().await;
        guard.injected_target_ids = verified_target_ids;
        let s = &mut *status.lock().await;
        s.codex_running = true;
        s.cdp_available = true;
        s.injected = !guard.injected_target_ids.is_empty();
        s.injected_target_count = guard.injected_target_ids.len();
        s.last_event = "CDP renderer 与模型目录已核验".into();
        if s.injected {
            s.message = format!(
                "已守护 {} 个 CDP renderer target；模型菜单注入有效。",
                guard.injected_target_ids.len()
            );
        } else {
            s.message = "CDP 可用但尚未注入（可能 target 启动中）".into();
        }
        return;
    }

    // 4. 有新 target、目录变化或 renderer 状态丢失时尝试注入。
    let gen = {
        let mut guard = inner.lock().await;
        guard.inject_generation += 1;
        guard.inject_generation
    };

    {
        let mut s = status.lock().await;
        s.codex_running = true;
        s.cdp_available = true;
        s.injected = !verified_target_ids.is_empty();
        s.injected_target_count = verified_target_ids.len();
        s.last_event = if catalog_changed {
            format!("检测到模型目录变化，发起注入 (gen {gen})")
        } else if new_ids.is_empty() {
            format!("检测到 renderer 兼容层失效，发起注入 (gen {gen})")
        } else {
            format!("检测到新 CDP target，发起注入 (gen {gen})")
        };
        s.message = if catalog_changed {
            "Provider 模型目录已更新，正在刷新现有 Codex Desktop renderer...".into()
        } else if new_ids.is_empty() {
            "Codex Desktop renderer 已重载或状态无法核验，正在恢复模型菜单兼容层...".into()
        } else {
            format!(
                "检测到 {} 个新 CDP renderer target，正在注入...",
                new_ids.len()
            )
        };
    }

    let mut injection = None;
    for port in target_ports {
        if let Some(result) = try_inject_on_candidate_ports(&catalog, &[port]).await {
            if result.injected || injection.is_none() {
                injection = Some(result);
            }
        }
    }
    let verified_target_ids = current_renderer_target_ids(&current_targets, &catalog).await;
    let injected_target_count = verified_target_ids.len();
    {
        let mut guard = inner.lock().await;
        // A successful port-level attempt does not prove every discovered
        // target was injected. Unconfirmed targets must be retried next cycle.
        guard.injected_target_ids = verified_target_ids;
        guard.injected_catalog_fingerprint =
            (injected_target_count > 0).then_some(catalog_fingerprint);
    }
    {
        let mut s = status.lock().await;
        s.codex_running = true;
        s.cdp_available = true;
        s.injected = injected_target_count > 0;
        s.injected_target_count = injected_target_count;
    }
    match injection {
        Some(result) if result.injected => {
            let mut s = status.lock().await;
            if injected_target_count == current_targets.len() {
                s.last_event = format!("注入成功 (gen {gen})");
                s.message = format!(
                    "已核验 {} 个 renderer target 的模型菜单兼容层 (gen {gen})。",
                    injected_target_count
                );
            } else {
                s.last_event = format!("注入核验未完成 (gen {gen})");
                s.message = format!(
                    "已核验 {}/{} 个 renderer target；未核验的 target 将在下次守护检查时重试。",
                    injected_target_count,
                    current_targets.len()
                );
            }
            log::info!(
                "Codex 守护: 模型菜单已注入 target={:?}, models={}",
                result.target_id,
                result.model_count
            );
        }
        Some(result) => {
            let mut s = status.lock().await;
            s.codex_running = true;
            s.cdp_available = true;
            s.last_event = format!("注入未完成 (gen {gen})");
            s.message = format!("模型菜单注入尝试未完成: {}", result.message);
            log::warn!("Codex 守护: 注入未完成: {}", result.message);
        }
        None => {
            let mut s = status.lock().await;
            s.codex_running = true;
            s.cdp_available = true;
            s.last_event = format!("注入失败 (gen {gen})");
            s.message = "模型菜单注入失败：未找到可注入的 CDP target。".into();
            log::warn!("Codex 守护: 注入失败，未找到可注入的 target");
        }
    }
}

async fn current_renderer_target_ids(
    targets: &[(String, String)],
    catalog: &CodexModelCatalogProjection,
) -> Vec<String> {
    let mut verified = Vec::new();
    for (id, websocket_url) in targets {
        match codex_renderer_compatibility_is_current(websocket_url, catalog).await {
            Ok(true) => verified.push(id.clone()),
            Ok(false) => {}
            Err(error) => log::debug!("Codex guardian renderer verification failed: {error}"),
        }
    }
    verified
}

fn guardian_should_inject(
    new_target_ids: &[String],
    injected_catalog_fingerprint: Option<&str>,
    current_catalog_fingerprint: &str,
    renderers_current: bool,
) -> bool {
    !new_target_ids.is_empty()
        || injected_catalog_fingerprint != Some(current_catalog_fingerprint)
        || !renderers_current
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    #[test]
    fn guardian_reinjects_existing_targets_when_catalog_changes() {
        let no_new_targets = Vec::<String>::new();

        assert!(guardian_should_inject(
            &no_new_targets,
            Some("catalog-v1"),
            "catalog-v2",
            true,
        ));
    }

    #[test]
    fn guardian_keeps_unchanged_catalog_injection_idempotent() {
        let no_new_targets = Vec::<String>::new();

        assert!(!guardian_should_inject(
            &no_new_targets,
            Some("catalog-v2"),
            "catalog-v2",
            true,
        ));
    }

    #[test]
    fn guardian_injects_new_targets_even_when_catalog_is_unchanged() {
        let new_targets = vec!["renderer-2".to_string()];

        assert!(guardian_should_inject(
            &new_targets,
            Some("catalog-v2"),
            "catalog-v2",
            true,
        ));
    }

    #[test]
    fn guardian_reinjects_unchanged_targets_after_renderer_reload() {
        assert!(guardian_should_inject(
            &[],
            Some("catalog-v2"),
            "catalog-v2",
            false,
        ));
    }

    #[test]
    fn guardian_does_not_treat_prior_injection_as_current_renderer_evidence() {
        for fingerprint in [None, Some("catalog-v2")] {
            assert!(guardian_should_inject(
                &[],
                fingerprint,
                "catalog-v2",
                false,
            ));
        }
    }

    #[tokio::test]
    async fn guardian_tracks_only_renderers_with_successful_current_payload_probes() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake CDP listener");
        let address = listener.local_addr().expect("fake CDP address");
        let server = tokio::spawn(async move {
            for current in [Some(true), Some(false), None] {
                let (stream, _) = listener.accept().await.expect("accept CDP connection");
                let mut socket = accept_async(stream).await.expect("accept CDP websocket");
                while let Some(message) = socket.next().await {
                    let message = message.expect("read CDP request");
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let request: serde_json::Value =
                        serde_json::from_str(text.as_str()).expect("parse CDP request");
                    let evaluating = request["method"] == "Runtime.evaluate";
                    let response = if evaluating {
                        match current {
                            Some(current) => json!({
                                "id": request["id"],
                                "result": {"result": {"type": "boolean", "value": current}}
                            }),
                            None => json!({
                                "id": request["id"],
                                "error": {"code": -32000, "message": "renderer unavailable"}
                            }),
                        }
                    } else {
                        json!({"id": request["id"], "result": {}})
                    };
                    socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .expect("send CDP response");
                    if evaluating {
                        break;
                    }
                }
            }
        });
        let targets = ["current", "reloaded", "unreachable"]
            .into_iter()
            .map(|id| (id.to_string(), format!("ws://{address}/devtools/page/{id}")))
            .collect::<Vec<_>>();
        let catalog = CodexModelCatalogProjection::empty();

        let verified = current_renderer_target_ids(&targets, &catalog).await;
        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("all renderer probes must finish")
            .expect("complete fake CDP server");

        assert_eq!(verified, vec!["current"]);
        assert!(guardian_should_inject(
            &[],
            Some("catalog-v2"),
            "catalog-v2",
            verified.len() == targets.len(),
        ));
    }
}
