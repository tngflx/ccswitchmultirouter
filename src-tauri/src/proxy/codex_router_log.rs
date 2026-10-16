//! Codex router diagnostic log.
//!
//! 普通 usage log 记录计费用的请求摘要；router 排障还需要一条紧凑时间线，
//! 用来定位模型解析、认证、上游发送和首包等待分别花了多久。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_ROUTER_LOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROTATED_ROUTER_LOGS: usize = 3;

type SharedRouterLogWriter = Mutex<Option<RouterLogWriter>>;

struct RouterLogWriter {
    path: PathBuf,
    file: File,
    bytes: u64,
}

fn shared_writer() -> &'static SharedRouterLogWriter {
    static WRITER: OnceLock<SharedRouterLogWriter> = OnceLock::new();
    WRITER.get_or_init(|| Mutex::new(None))
}

/// 向 `codex-router.log` 追加一条清洗后的 Codex router 诊断事件。
///
/// 只记录阶段、模型、provider、耗时等摘要，不写 prompt、header 原文或 SSE
/// 内容。该日志只用于排障，所以写入失败会被忽略，不能影响真实代理请求。
///
/// Reuse the file handle and bound disk usage. Events remain immediately visible
/// to diagnostics, even if no later request arrives. The mutex protects only the
/// local write and never holds a network or async lock.
pub(crate) fn append_event(event: &str, fields: &[(&str, String)]) {
    let log_dir = crate::config::get_app_config_dir().join("logs");
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }

    let path = log_dir.join("codex-router.log");
    let mut line = format!(
        "{} event={}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        sanitize_value(event)
    );
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&sanitize_value(value));
    }
    line.push('\n');

    let Ok(mut shared) = shared_writer().lock() else {
        return;
    };
    append_log_line(&mut shared, &path, &line);
}

fn append_log_line(shared: &mut Option<RouterLogWriter>, path: &Path, line: &str) {
    let reopen = shared
        .as_ref()
        .is_none_or(|writer| writer.path != path || !path.exists());
    if reopen {
        *shared = open_router_log_writer(path);
    }

    if shared
        .as_ref()
        .is_some_and(|writer| writer.bytes >= MAX_ROUTER_LOG_BYTES)
    {
        // Close the Windows file handle before renaming.
        *shared = None;
        rotate_router_log(path);
        *shared = open_router_log_writer(path);
    }

    let Some(writer) = shared.as_mut() else {
        return;
    };
    if writer.file.write_all(line.as_bytes()).is_err() {
        return;
    }
    writer.bytes = writer.bytes.saturating_add(line.len() as u64);
}

fn open_router_log_writer(path: &Path) -> Option<RouterLogWriter> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    let bytes = file.metadata().ok()?.len();
    Some(RouterLogWriter {
        path: path.to_path_buf(),
        file,
        bytes,
    })
}

fn rotate_router_log(path: &Path) {
    for index in (1..=MAX_ROTATED_ROUTER_LOGS).rev() {
        let destination = rotated_router_log_path(path, index);
        if index == MAX_ROTATED_ROUTER_LOGS {
            let _ = fs::remove_file(&destination);
        } else {
            let source = rotated_router_log_path(path, index);
            let next_destination = rotated_router_log_path(path, index + 1);
            let _ = fs::rename(source, next_destination);
        }
    }
    let first_backup = rotated_router_log_path(path, 1);
    let _ = fs::rename(path, first_backup);
}

fn rotated_router_log_path(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), index))
}

/// 将日志字段清洗成单行安全文本。
///
/// 明显的 API key/token 会被遮盖，空白字符会折叠为下划线，避免异常值污染
/// 下一行日志。
fn sanitize_value(value: &str) -> String {
    let value = value.replace(['\r', '\n', '\t'], " ");
    let mut parts = Vec::new();
    for part in value.split_whitespace() {
        let lower = part.to_ascii_lowercase();
        if lower.starts_with("sk-")
            || lower.contains("bearer ")
            || lower.contains("api_key")
            || lower.contains("apikey")
            || lower.contains("token")
        {
            parts.push("<redacted>".to_string());
        } else {
            parts.push(part.to_string());
        }
    }
    parts.join("_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_router_log_event_is_visible_without_waiting_for_another_request() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("codex-router.log");
        let mut writer = None;
        append_log_line(&mut writer, &path, "event=route_resolved\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "event=route_resolved\n");
    }

    #[test]
    fn full_router_log_is_closed_and_rotated_before_the_next_write() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("codex-router.log");
        File::create(&path)
            .unwrap()
            .set_len(MAX_ROUTER_LOG_BYTES)
            .unwrap();
        let mut writer = open_router_log_writer(&path);
        append_log_line(&mut writer, &path, "event=route_resolved\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "event=route_resolved\n");
        assert_eq!(
            fs::metadata(rotated_router_log_path(&path, 1))
                .unwrap()
                .len(),
            MAX_ROUTER_LOG_BYTES
        );
    }

    #[test]
    fn router_log_rotation_keeps_only_bounded_backups() {
        let temp_dir = tempfile::tempdir().expect("temporary log directory");
        let path = temp_dir.path().join("codex-router.log");
        fs::write(&path, "current").expect("write current log");
        fs::write(rotated_router_log_path(&path, 1), "backup-1").expect("write backup 1");
        fs::write(rotated_router_log_path(&path, 2), "backup-2").expect("write backup 2");
        fs::write(rotated_router_log_path(&path, 3), "backup-3").expect("write backup 3");

        rotate_router_log(&path);

        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(rotated_router_log_path(&path, 1)).unwrap(),
            "current"
        );
        assert_eq!(
            fs::read_to_string(rotated_router_log_path(&path, 2)).unwrap(),
            "backup-1"
        );
        assert_eq!(
            fs::read_to_string(rotated_router_log_path(&path, 3)).unwrap(),
            "backup-2"
        );
    }
}
