//! Codex router diagnostic log.
//!
//! 普通 usage log 记录计费用的请求摘要；router 排障还需要一条紧凑时间线，
//! 用来定位模型解析、认证、上游发送和首包等待分别花了多久。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, OnceLock};

const MAX_ROUTER_LOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROTATED_ROUTER_LOGS: usize = 3;
const ROUTER_LOG_QUEUE_CAPACITY: usize = 256;
const MAX_ROUTER_LOG_LINE_BYTES: usize = 32 * 1024;

struct RouterLogWriter {
    path: PathBuf,
    file: File,
    bytes: u64,
}

fn shared_writer() -> Option<&'static mpsc::SyncSender<Box<str>>> {
    static WRITER: OnceLock<Option<mpsc::SyncSender<Box<str>>>> = OnceLock::new();
    WRITER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel(ROUTER_LOG_QUEUE_CAPACITY);
            let worker = std::thread::Builder::new()
                .name("codex-router-log".into())
                .spawn(move || {
                    write_log_messages(receiver, || {
                        crate::config::get_app_config_dir()
                            .join("logs")
                            .join("codex-router.log")
                    })
                });
            worker.ok().map(|_| sender)
        })
        .as_ref()
}

fn write_log_messages(receiver: mpsc::Receiver<Box<str>>, log_path: impl Fn() -> PathBuf) {
    let mut writer = None;
    for line in receiver {
        append_log_line(&mut writer, &log_path(), &line);
    }
}

/// 向 `codex-router.log` 追加一条清洗后的 Codex router 诊断事件。
///
/// 只记录阶段、模型、provider、耗时等摘要，不写 prompt、header 原文或 SSE
/// 内容。该日志只用于排障，所以写入失败会被忽略，不能影响真实代理请求。
///
/// Reuse the file handle and bound disk usage. The bounded queue keeps filesystem
/// work off request-forwarding threads. Events are best-effort diagnostics and
/// may be dropped when the queue is full or an event exceeds the line limit.
pub(crate) fn append_event(event: &str, fields: &[(&str, String)]) {
    if let Some(sender) = shared_writer() {
        queue_event(sender, event, fields);
    }
}

fn queue_event(sender: &mpsc::SyncSender<Box<str>>, event: &str, fields: &[(&str, String)]) {
    // Reject oversized summaries before sanitizing so an unusually large field
    // cannot allocate an oversized queue entry or require an unbounded scan.
    let mut bytes = event.len().saturating_add(32);
    for (key, value) in fields {
        bytes = bytes
            .saturating_add(key.len())
            .saturating_add(value.len())
            .saturating_add(2);
        if bytes > MAX_ROUTER_LOG_LINE_BYTES {
            return;
        }
    }
    if bytes > MAX_ROUTER_LOG_LINE_BYTES {
        return;
    }

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

    // Redaction placeholders can expand short input tokens.
    if line.len() <= MAX_ROUTER_LOG_LINE_BYTES {
        let _ = sender.try_send(line.into_boxed_str());
    }
}

fn append_log_line(current: &mut Option<RouterLogWriter>, path: &Path, line: &str) {
    let reopen = current
        .as_ref()
        .is_none_or(|writer| writer.path != path || !path.exists());
    if reopen {
        *current = open_router_log_writer(path);
    }

    if current
        .as_ref()
        .is_some_and(|writer| writer.bytes >= MAX_ROUTER_LOG_BYTES)
    {
        // Close the Windows file handle before renaming.
        *current = None;
        rotate_router_log(path);
        *current = open_router_log_writer(path);
    }

    let Some(writer) = current.as_mut() else {
        return;
    };
    if writer.file.write_all(line.as_bytes()).is_err() {
        *current = None;
        return;
    }
    writer.bytes = writer.bytes.saturating_add(line.len() as u64);
}

fn open_router_log_writer(path: &Path) -> Option<RouterLogWriter> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok()?;
    }
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
    // `split_whitespace` already treats CR, LF, and tabs as separators. Build
    // the final value directly so diagnostic logging does not allocate a
    // normalized copy, one owned String per token, and a second joined copy.
    let mut sanitized = String::with_capacity(value.len());
    let mut needs_separator = false;
    for part in value.split_whitespace() {
        if needs_separator {
            sanitized.push('_');
        }
        needs_separator = true;
        let lower = part.to_ascii_lowercase();
        if lower.starts_with("sk-")
            || lower.contains("bearer ")
            || lower.contains("api_key")
            || lower.contains("apikey")
            || lower.contains("token")
        {
            sanitized.push_str("<redacted>");
        } else {
            sanitized.push_str(part);
        }
    }
    sanitized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_log_queue_bounds_pending_work_and_preserves_order() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("logs").join("codex-router.log");
        let (sender, receiver) = mpsc::sync_channel(ROUTER_LOG_QUEUE_CAPACITY);

        for index in 0..ROUTER_LOG_QUEUE_CAPACITY {
            queue_event(&sender, "route_resolved", &[("index", index.to_string())]);
        }
        // With the writer paused, enqueuing further events must still return.
        let (finished, wait_for_producer) = mpsc::channel();
        let producer = std::thread::spawn(move || {
            queue_event(&sender, "overflow", &[]);
            finished.send(()).unwrap();
        });
        wait_for_producer
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("submitting diagnostics must not wait for the writer");
        producer.join().unwrap();
        assert!(!path.parent().unwrap().exists());
        write_log_messages(receiver, || path.clone());

        let log = fs::read_to_string(&path).unwrap();
        assert_eq!(log.lines().count(), ROUTER_LOG_QUEUE_CAPACITY);
        for (index, line) in log.lines().enumerate() {
            assert!(line.ends_with(&format!(" event=route_resolved index={index}")));
        }
    }

    #[test]
    fn router_log_queue_bounds_entry_size_before_and_after_redaction() {
        let (sender, receiver) = mpsc::sync_channel(1);
        queue_event(
            &sender,
            "oversized",
            &[("detail", "x".repeat(MAX_ROUTER_LOG_LINE_BYTES))],
        );
        queue_event(&sender, "expanded", &[("detail", "sk- ".repeat(4000))]);
        queue_event(
            &sender,
            "bounded",
            &[("detail", "example sk-fixture".into())],
        );

        let line = receiver.try_recv().unwrap();
        assert!(line.ends_with(" event=bounded detail=example_<redacted>\n"));
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

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

    #[test]
    fn sanitize_value_collapses_whitespace_and_redacts_sensitive_tokens() {
        assert_eq!(
            sanitize_value("  route\r\n provider\t sk-secret bearer token api_key=value "),
            "route_provider_<redacted>_bearer_<redacted>_<redacted>"
        );
    }
}
