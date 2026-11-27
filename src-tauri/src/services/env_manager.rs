use super::env_checker::EnvConflict;
use chrono::{NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

const ENV_BACKUP_TIME_FORMAT: &str = "%Y%m%d_%H%M%S";
static ENV_BACKUP_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub backup_path: String,
    pub timestamp: String,
    pub conflicts: Vec<EnvConflict>,
}

/// Delete environment variables with automatic backup
pub fn delete_env_vars(conflicts: Vec<EnvConflict>) -> Result<BackupInfo, String> {
    // Step 1: Create backup
    let backup_info = create_backup(&conflicts)?;

    // Step 2: Delete variables
    for conflict in &conflicts {
        match delete_single_env(conflict) {
            Ok(_) => {}
            Err(e) => {
                // If deletion fails, we keep the backup but return error
                return Err(format!(
                    "删除环境变量失败: {}. 备份已保存到: {}",
                    e, backup_info.backup_path
                ));
            }
        }
    }

    Ok(backup_info)
}

/// Create backup file before deletion
fn create_backup(conflicts: &[EnvConflict]) -> Result<BackupInfo, String> {
    let _lock = ENV_BACKUP_LOCK
        .lock()
        .map_err(|_| "环境变量备份无法使用".to_string())?;
    let backup_dir = get_backup_dir()?;
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let timestamp = Utc::now().format(ENV_BACKUP_TIME_FORMAT).to_string();
    let mut backup_file = backup_dir.join(format!("env-backup-{timestamp}.json"));
    let mut sequence = 1;
    while backup_file
        .try_exists()
        .map_err(|e| format!("检查环境变量备份失败: {e}"))?
    {
        backup_file = backup_dir.join(format!("env-backup-{timestamp}_{sequence}.json"));
        sequence += 1;
    }

    // Create backup data
    let backup_info = BackupInfo {
        backup_path: backup_file.to_string_lossy().to_string(),
        timestamp,
        conflicts: conflicts.to_vec(),
    };

    // Write backup file
    let json = serde_json::to_string_pretty(&backup_info)
        .map_err(|e| format!("序列化备份数据失败: {e}"))?;

    crate::config::atomic_write_private(&backup_file, json.as_bytes())
        .map_err(|e| format!("写入备份文件失败: {e}"))?;

    let retain = crate::settings::effective_backup_retain_count();
    if let Err(error) = cleanup_env_backups(&backup_dir, &backup_file, retain) {
        log::warn!("清理旧环境变量备份失败: {error}");
    }

    Ok(backup_info)
}

fn env_backup_order(name: &str) -> Option<(NaiveDateTime, u32)> {
    let id = name.strip_prefix("env-backup-")?.strip_suffix(".json")?;
    let timestamp = NaiveDateTime::parse_from_str(id.get(..15)?, ENV_BACKUP_TIME_FORMAT).ok()?;
    let sequence = match id.get(15..)? {
        "" => 0,
        suffix => {
            let number = suffix.strip_prefix('_')?;
            if number.starts_with('0') || !number.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            number.parse().ok()?
        }
    };
    Some((timestamp, sequence))
}

fn cleanup_env_backups(dir: &Path, current: &Path, retain: usize) -> std::io::Result<()> {
    let mut entries = fs::read_dir(dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let order = env_backup_order(name.to_str()?)?;
            let path = entry.path();
            (path != current && entry.file_type().ok()?.is_file()).then_some((order, path))
        })
        .collect::<Vec<_>>();

    entries.sort_unstable_by_key(|(order, _)| std::cmp::Reverse(*order));
    // Reserve a slot for the backup just written, even if the clock moved backwards.
    for (_, path) in entries.into_iter().skip(retain - 1) {
        if let Err(error) = fs::remove_file(&path) {
            log::warn!("删除旧环境变量备份 {} 失败: {error}", path.display());
        }
    }

    Ok(())
}

/// Get backup directory path
fn get_backup_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法获取用户主目录")?;
    Ok(home.join(".cc-switch").join("backups"))
}

/// Delete a single environment variable
#[cfg(target_os = "windows")]
fn delete_single_env(conflict: &EnvConflict) -> Result<(), String> {
    match conflict.source_type.as_str() {
        "system" => {
            if conflict.source_path.contains("HKEY_CURRENT_USER") {
                let hkcu = RegKey::predef(HKEY_CURRENT_USER)
                    .open_subkey_with_flags("Environment", KEY_ALL_ACCESS)
                    .map_err(|e| format!("打开注册表失败: {}", e))?;

                hkcu.delete_value(&conflict.var_name)
                    .map_err(|e| format!("删除注册表项失败: {}", e))?;
            } else if conflict.source_path.contains("HKEY_LOCAL_MACHINE") {
                let hklm = RegKey::predef(HKEY_LOCAL_MACHINE)
                    .open_subkey_with_flags(
                        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
                        KEY_ALL_ACCESS,
                    )
                    .map_err(|e| format!("打开系统注册表失败 (需要管理员权限): {}", e))?;

                hklm.delete_value(&conflict.var_name)
                    .map_err(|e| format!("删除系统注册表项失败: {}", e))?;
            }
            Ok(())
        }
        "file" => Err("Windows 系统不应该有文件类型的环境变量".to_string()),
        _ => Err(format!("未知的环境变量来源类型: {}", conflict.source_type)),
    }
}

#[cfg(not(target_os = "windows"))]
fn delete_single_env(conflict: &EnvConflict) -> Result<(), String> {
    match conflict.source_type.as_str() {
        "file" => {
            // Parse file path and line number from source_path (format: "path:line")
            let parts: Vec<&str> = conflict.source_path.split(':').collect();
            if parts.len() < 2 {
                return Err("无效的文件路径格式".to_string());
            }

            let file_path = parts[0];

            // Read file content
            let content = fs::read_to_string(file_path)
                .map_err(|e| format!("读取文件失败 {file_path}: {e}"))?;

            // Filter out the line containing the environment variable
            let new_content: Vec<String> = content
                .lines()
                .filter(|line| {
                    let trimmed = line.trim();
                    let export_line = trimmed.strip_prefix("export ").unwrap_or(trimmed);

                    // Check if this line sets the target variable
                    if let Some(eq_pos) = export_line.find('=') {
                        let var_name = export_line[..eq_pos].trim();
                        var_name != conflict.var_name
                    } else {
                        true
                    }
                })
                .map(|s| s.to_string())
                .collect();

            // Write back to file
            fs::write(file_path, new_content.join("\n"))
                .map_err(|e| format!("写入文件失败 {file_path}: {e}"))?;

            Ok(())
        }
        "system" => {
            // On Unix, we can't directly delete process environment variables
            Ok(())
        }
        _ => Err(format!("未知的环境变量来源类型: {}", conflict.source_type)),
    }
}

/// Restore environment variables from backup
pub fn restore_from_backup(backup_path: String) -> Result<(), String> {
    // Read backup file
    let content = fs::read_to_string(&backup_path).map_err(|e| format!("读取备份文件失败: {e}"))?;

    let backup_info: BackupInfo =
        serde_json::from_str(&content).map_err(|e| format!("解析备份文件失败: {e}"))?;

    // Restore each variable
    for conflict in &backup_info.conflicts {
        restore_single_env(conflict)?;
    }

    Ok(())
}

/// Restore a single environment variable
#[cfg(target_os = "windows")]
fn restore_single_env(conflict: &EnvConflict) -> Result<(), String> {
    match conflict.source_type.as_str() {
        "system" => {
            if conflict.source_path.contains("HKEY_CURRENT_USER") {
                let (hkcu, _) = RegKey::predef(HKEY_CURRENT_USER)
                    .create_subkey("Environment")
                    .map_err(|e| format!("打开注册表失败: {}", e))?;

                hkcu.set_value(&conflict.var_name, &conflict.var_value)
                    .map_err(|e| format!("恢复注册表项失败: {}", e))?;
            } else if conflict.source_path.contains("HKEY_LOCAL_MACHINE") {
                let (hklm, _) = RegKey::predef(HKEY_LOCAL_MACHINE)
                    .create_subkey(
                        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
                    )
                    .map_err(|e| format!("打开系统注册表失败 (需要管理员权限): {}", e))?;

                hklm.set_value(&conflict.var_name, &conflict.var_value)
                    .map_err(|e| format!("恢复系统注册表项失败: {}", e))?;
            }
            Ok(())
        }
        _ => Err(format!(
            "无法恢复类型为 {} 的环境变量",
            conflict.source_type
        )),
    }
}

#[cfg(not(target_os = "windows"))]
fn restore_single_env(conflict: &EnvConflict) -> Result<(), String> {
    match conflict.source_type.as_str() {
        "file" => {
            // Parse file path from source_path
            let parts: Vec<&str> = conflict.source_path.split(':').collect();
            if parts.is_empty() {
                return Err("无效的文件路径格式".to_string());
            }

            let file_path = parts[0];

            // Read file content
            let mut content = fs::read_to_string(file_path)
                .map_err(|e| format!("读取文件失败 {file_path}: {e}"))?;

            // Append the environment variable line
            let export_line = format!("\nexport {}={}", conflict.var_name, conflict.var_value);
            content.push_str(&export_line);

            // Write back to file
            fs::write(file_path, content).map_err(|e| format!("写入文件失败 {file_path}: {e}"))?;

            Ok(())
        }
        _ => Err(format!(
            "无法恢复类型为 {} 的环境变量",
            conflict.source_type
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backup_dir_creation() {
        let backup_dir = get_backup_dir();
        assert!(backup_dir.is_ok());
    }

    #[test]
    fn cleanup_env_backups_keeps_current_and_latest_previous_snapshot() {
        let temp = tempfile::tempdir().expect("temporary backup directory");
        let current = "env-backup-20240101_000000.json";
        let newest_previous = "env-backup-20240102_000000_10.json";
        let older = "env-backup-20240102_000000_9.json";
        let other_json = "env-backup-manual.json";
        let other_dir = "env-backup-20230101_000000.json";
        for name in [newest_previous, older, current, other_json] {
            fs::write(temp.path().join(name), "{}").expect("write backup fixture");
        }
        fs::create_dir(temp.path().join(other_dir)).expect("create unrelated directory");

        cleanup_env_backups(temp.path(), &temp.path().join(current), 2)
            .expect("cleanup environment backups");

        assert!(temp.path().join(current).is_file());
        assert!(temp.path().join(newest_previous).is_file());
        assert!(!temp.path().join(older).exists());
        assert!(temp.path().join(other_json).is_file());
        assert!(temp.path().join(other_dir).is_dir());
    }
}
