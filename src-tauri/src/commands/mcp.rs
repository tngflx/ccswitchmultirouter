#![allow(non_snake_case)]

use indexmap::IndexMap;
use std::collections::HashMap;

use serde::Serialize;
use tauri::AppHandle;

use crate::app_config::AppType;
use crate::claude_mcp;
use crate::services::McpService;

/// 获取 Claude MCP 状态
#[tauri::command]
pub async fn get_claude_mcp_status() -> Result<claude_mcp::McpStatus, String> {
    super::run_command_blocking(|| claude_mcp::get_mcp_status().map_err(|e| e.to_string())).await
}

/// 读取 mcp.json 文本内容
#[tauri::command]
pub async fn read_claude_mcp_config() -> Result<Option<String>, String> {
    super::run_command_blocking(|| claude_mcp::read_mcp_json().map_err(|e| e.to_string())).await
}

/// 新增或更新一个 MCP 服务器条目
#[tauri::command]
pub async fn upsert_claude_mcp_server(id: String, spec: serde_json::Value) -> Result<bool, String> {
    super::run_command_blocking(move || {
        claude_mcp::upsert_mcp_server(&id, spec).map_err(|e| e.to_string())
    })
    .await
}

/// 删除一个 MCP 服务器条目
#[tauri::command]
pub async fn delete_claude_mcp_server(id: String) -> Result<bool, String> {
    super::run_command_blocking(move || {
        claude_mcp::delete_mcp_server(&id).map_err(|e| e.to_string())
    })
    .await
}

/// 校验命令是否在 PATH 中可用（不执行）
#[tauri::command]
pub async fn validate_mcp_command(cmd: String) -> Result<bool, String> {
    super::run_command_blocking(move || {
        claude_mcp::validate_command_in_path(&cmd).map_err(|e| e.to_string())
    })
    .await
}

#[derive(Serialize)]
pub struct McpConfigResponse {
    pub config_path: String,
    pub servers: HashMap<String, serde_json::Value>,
}

/// 获取 MCP 配置（来自 ~/.cc-switch/config.json）
use std::str::FromStr;

#[tauri::command]
#[allow(deprecated)] // 兼容层命令，内部调用已废弃的 Service 方法
pub async fn get_mcp_config(
    app_handle: AppHandle,
    app: String,
) -> Result<McpConfigResponse, String> {
    let app_ty = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_app_state_blocking(&app_handle, move |state| {
        let config_path = crate::config::get_app_config_path()
            .to_string_lossy()
            .to_string();
        let servers = McpService::get_servers(state, app_ty).map_err(|e| e.to_string())?;
        Ok(McpConfigResponse {
            config_path,
            servers,
        })
    })
    .await
}

/// 在 config.json 中新增或更新一个 MCP 服务器定义
/// [已废弃] 该命令仍然使用旧的分应用API，会转换为统一结构
#[tauri::command]
pub async fn upsert_mcp_server_in_config(
    app_handle: AppHandle,
    app: String,
    id: String,
    spec: serde_json::Value,
    sync_other_side: Option<bool>,
) -> Result<bool, String> {
    use crate::app_config::McpServer;

    let app_ty = AppType::from_str(&app).map_err(|e| e.to_string())?;

    super::run_app_state_blocking(&app_handle, move |state| {
        // 读取现有的服务器（如果存在）
        let existing_server = {
            let servers = state.db.get_all_mcp_servers().map_err(|e| e.to_string())?;
            servers.get(&id).cloned()
        };

        // 构建新的统一服务器结构
        let mut new_server = if let Some(mut existing) = existing_server {
            existing.server = spec.clone();
            existing.apps.set_enabled_for(&app_ty, true);
            existing
        } else {
            let mut apps = crate::app_config::McpApps::default();
            apps.set_enabled_for(&app_ty, true);
            let name = spec
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&id)
                .to_string();
            McpServer {
                id: id.clone(),
                name,
                server: spec,
                apps,
                description: None,
                homepage: None,
                docs: None,
                tags: Vec::new(),
            }
        };

        if sync_other_side.unwrap_or(false) {
            new_server.apps.claude = true;
            new_server.apps.codex = true;
            new_server.apps.gemini = true;
            new_server.apps.opencode = true;
        }

        McpService::upsert_server(state, new_server)
            .map(|_| true)
            .map_err(|e| e.to_string())
    })
    .await
}

/// 在 config.json 中删除一个 MCP 服务器定义
#[tauri::command]
pub async fn delete_mcp_server_in_config(
    app_handle: AppHandle,
    _app: String, // 参数保留用于向后兼容，但在统一结构中不再需要
    id: String,
) -> Result<bool, String> {
    super::run_app_state_blocking(&app_handle, move |state| {
        McpService::delete_server(state, &id).map_err(|e| e.to_string())
    })
    .await
}

/// 设置启用状态并同步到客户端配置
#[tauri::command]
#[allow(deprecated)] // 兼容层命令，内部调用已废弃的 Service 方法
pub async fn set_mcp_enabled(
    app_handle: AppHandle,
    app: String,
    id: String,
    enabled: bool,
) -> Result<bool, String> {
    let app_ty = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_app_state_blocking(&app_handle, move |state| {
        McpService::set_enabled(state, app_ty, &id, enabled).map_err(|e| e.to_string())
    })
    .await
}

// ============================================================================
// v3.7.0 新增：统一 MCP 管理命令
// ============================================================================

use crate::app_config::McpServer;

/// 获取所有 MCP 服务器（统一结构）
#[tauri::command]
pub async fn get_mcp_servers(app: AppHandle) -> Result<IndexMap<String, McpServer>, String> {
    super::run_app_state_blocking(&app, |state| {
        McpService::get_all_servers(state).map_err(|e| e.to_string())
    })
    .await
}

/// 添加或更新 MCP 服务器
#[tauri::command]
pub async fn upsert_mcp_server(app: AppHandle, server: McpServer) -> Result<(), String> {
    super::run_app_state_blocking(&app, move |state| {
        McpService::upsert_server(state, server).map_err(|e| e.to_string())
    })
    .await
}

/// 删除 MCP 服务器
#[tauri::command]
pub async fn delete_mcp_server(app: AppHandle, id: String) -> Result<bool, String> {
    super::run_app_state_blocking(&app, move |state| {
        McpService::delete_server(state, &id).map_err(|e| e.to_string())
    })
    .await
}

/// 切换 MCP 服务器在指定应用的启用状态
#[tauri::command]
pub async fn toggle_mcp_app(
    app_handle: AppHandle,
    server_id: String,
    app: String,
    enabled: bool,
) -> Result<(), String> {
    let app_ty = AppType::from_str(&app).map_err(|e| e.to_string())?;
    super::run_app_state_blocking(&app_handle, move |state| {
        McpService::toggle_app(state, &server_id, app_ty, enabled).map_err(|e| e.to_string())
    })
    .await
}

/// 从所有应用导入 MCP 服务器（复用已有的导入逻辑）
#[tauri::command]
pub async fn import_mcp_from_apps(app: AppHandle) -> Result<usize, String> {
    super::run_app_state_blocking(&app, |state| {
        McpService::import_from_all_apps(state).map_err(|e| e.to_string())
    })
    .await
}
