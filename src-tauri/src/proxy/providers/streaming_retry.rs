//! Responses SSE 流中断的有界自动重连
//!
//! forwarder 的语义预热（`validate_responses_stream_start`）只保护提交前的失败：
//! 一旦上游发出第一个 productive 事件，响应就提交给下游客户端，此后上游掐断
//! SSE（Cloudflare 空闲切断、连接池陈旧连接等）会直接以 `stream_error` 终止整轮
//! 请求。官方 Codex CLI 对同类中断用 `stream_max_retries`（默认 5 次）整请求重发
//! 吸收；本模块把同样的语义移植到代理侧。
//!
//! 代理与 CLI 的关键差异：CLI 重试时可以丢弃已渲染的部分输出重画 UI，代理无法
//! 撤回已发给客户端的字节。因此重试只在下游尚未收到任何实质内容（至多收到
//! `message_start`/`ping` 这类协议脚手架）时进行——这恰好覆盖最常见的中断窗口：
//! 预热在 reasoning `output_item.added`（不向下游产出字节）后提交，随后模型长时间
//! 静默思考，空闲切断发生时下游只收到过 `message_start`。重试用全新的转换器实例
//! 重发同一上游请求，并抑制重复的 `message_start`，对客户端完全透明；一旦转发过
//! 实质内容，行为与现状一致（错误事件透传）。
//!
//! 上游语义性失败（`response.failed`/`error` 事件）不重试：那是上游的明确判决，
//! 与 #5546 在提交边界前的处理保持同一分界。可重试与否由转换器附加的
//! [`RETRYABLE_STREAM_MARKER`] 注释行标识，而非事件里的 `error.type`——后者
//! 逐字透传自上游可控字段，不可信。
//!
//! 包装器同时承担正常流转期间的思考期心跳：推理模型隐藏思考时上游可整段
//! 无事件，`message_start` 之后上游每静默 [`KEEPALIVE_INTERVAL`] 即向下游发
//! 一次 ping（至多 [`UPSTREAM_SILENCE_KEEPALIVE_LIMIT`]），防止下游空闲计时
//! 器（本代理 120s passthrough 超时、Claude Code 字节级 stream watchdog）把
//! 长思考误判为断流。

use super::codex_terminal::{
    classify_native_responses_terminal, NativeResponsesEvidence, NativeResponsesTerminalDisposition,
};
use super::streaming_responses::{
    anthropic_error_sse, anthropic_sse,
    create_anthropic_sse_stream_from_responses_with_web_search_options, RETRYABLE_STREAM_MARKER,
};
use crate::proxy::error::ProxyError;
use crate::proxy::hyper_client::ProxyResponse;
use crate::proxy::sse::{strip_sse_field, take_sse_block};
use bytes::{Bytes, BytesMut};
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// 与官方 Codex CLI 的 `stream_max_retries` 默认值对齐。
///
/// 普通流中断和容量类失败共用这一条硬上限；它们只在等待策略和
/// 错误分类上不同，任何路径都不能把单个请求扩展到五次以上重试。
pub(crate) const STREAM_MAX_RETRIES: u32 = 5;

/// 明确要求稍后再试的容量/并发失败，在没有 `Retry-After` 时等待十分钟。
///
/// 这不是普通断流的退避，也不适用于额度、认证或参数错误。它只用于上游
/// 明确返回“并发上限/高需求”文案的容量失败。
pub(crate) const CAPACITY_RETRY_LONG_DELAY: Duration = Duration::from_secs(10 * 60);

/// 长等待仍然受容量重试次数约束：最多五次，每次最多十分钟。
pub(crate) const CAPACITY_RETRY_LONG_TOTAL_DELAY_BUDGET: Duration =
    Duration::from_secs(10 * 60 * STREAM_MAX_RETRIES as u64);

/// 重连等待与正常流转静默期间向下游发 keepalive 的间隔。
///
/// 退避（≤3.2s）+ 重连（≤60s）+ 等待重连后首个事件（≤60s）三段串联可超过
/// 下游 `create_logged_passthrough_stream` 的单次 120s 空闲超时；每段内部
/// 都合规也可能被外层掐掉。周期性 ping 喂空闲计时器，保住合法的重试窗口。
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);

/// 正常流转期间容忍的上游连续静默上限，超过后停止心跳。
///
/// 推理模型（GPT-5 系）隐藏思考期间可能长时间不产出任何 SSE 事件——未请求
/// reasoning summary 时全程零事件，请求了摘要其增量也可能明显滞后。这种
/// 静默是合法的"仍在生成"状态，但下游无从分辨：本代理的 120s passthrough
/// 空闲超时会先掐断，即便调大，Claude Code 自身的字节级 stream watchdog
/// （2.1.157 实测 180s，当前版本默认 5 分钟）也会中止请求。心跳在此窗口内
/// 持续喂两级计时器；超过上限说明连接大概率已死（如 TCP 黑洞），停止心跳
/// 把裁决权交还给操作者配置的空闲超时，避免无限保活一条死流。
const UPSTREAM_SILENCE_KEEPALIVE_LIMIT: Duration = Duration::from_secs(300);

pub(crate) type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;
type ConnectFuture = Pin<Box<dyn Future<Output = Result<ProxyResponse, ProxyError>> + Send>>;
pub(crate) type ConnectFn = Box<dyn Fn() -> ConnectFuture + Send + Sync>;

/// 重新向同一供应商发起原始上游请求的工厂。
///
/// 由 `Forwarder::forward` 在发出首次请求前捕获最终解析的 URL/headers/body 构造；
/// 每次调用发出一条全新的上游连接（认证头沿用首次请求的令牌，重试窗口只有数秒，
/// 不需要重新走令牌刷新）。
pub struct StreamReconnector {
    connect: ConnectFn,
    first_byte_timeout: Duration,
    max_retries: u32,
    capacity_retry_enabled: bool,
}

/// 上游原生 Responses SSE 的最小排障关联信息。
///
/// 这里只保留本地 session/provider/model 标识，不携带请求正文、header 或完整
/// 上游错误消息；错误消息只会以固定类别和短 hash 进入 router log。
#[derive(Clone, Debug)]
pub(crate) struct StreamLogContext {
    pub(crate) session_id: String,
    pub(crate) model: String,
    pub(crate) provider_id: String,
}

fn emit_retry_activity(
    context: Option<&StreamLogContext>,
    stage: &str,
    event: &str,
    attempt: u32,
    max_attempts: u32,
    reason_class: Option<&str>,
) {
    let Some(context) = context else {
        return;
    };
    crate::usage_events::notify_stream_retry_activity(crate::usage_events::StreamRetryActivity {
        timestamp: chrono::Utc::now().to_rfc3339(),
        stage: sanitize_diagnostic_token(stage),
        event: sanitize_diagnostic_token(event),
        attempt,
        max_attempts: (max_attempts != u32::MAX).then_some(max_attempts),
        session_id: sanitize_diagnostic_token(&context.session_id),
        model: sanitize_diagnostic_token(&context.model),
        provider_id: sanitize_diagnostic_token(&context.provider_id),
        reason_class: reason_class.map(sanitize_diagnostic_token),
    });
}

impl StreamReconnector {
    pub fn new(connect: ConnectFn, first_byte_timeout: Duration) -> Self {
        Self {
            connect,
            first_byte_timeout,
            max_retries: STREAM_MAX_RETRIES,
            capacity_retry_enabled: false,
        }
    }

    pub fn with_max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = max_retries.min(STREAM_MAX_RETRIES);
        self
    }

    pub fn with_capacity_retry(mut self, enabled: bool) -> Self {
        self.capacity_retry_enabled = enabled;
        self
    }

    fn retry_limit_for(&self, capacity_error: bool) -> u32 {
        let _ = capacity_error;
        self.max_retries
    }

    fn retry_limit(&self) -> u32 {
        self.max_retries
    }

    pub(crate) async fn connect(&self) -> Result<ProxyResponse, ProxyError> {
        let diagnostic = crate::proxy::error_journal::Context::new(
            "responses_reconnect",
            &http::HeaderMap::new(),
        );
        let result = async {
            if self.first_byte_timeout.is_zero() {
                (self.connect)().await
            } else {
                tokio::time::timeout(self.first_byte_timeout, (self.connect)())
                    .await
                    .map_err(|_| {
                        ProxyError::Timeout(format!(
                            "Responses stream reconnect timed out after {}s",
                            self.first_byte_timeout.as_secs()
                        ))
                    })?
            }
        }
        .await;
        result
            .inspect_err(|error| diagnostic.failed(error))
            .map(|response| diagnostic.observe(response))
    }
}

fn upstream_sse_block_is_error(block: &[u8]) -> bool {
    let event = raw_responses_sse_event_name(block);
    let payload = raw_responses_sse_payload(block);
    matches!(
        event.as_deref(),
        Some("error" | "response.error" | "response.failed")
    ) || payload
        .as_ref()
        .is_some_and(|value| value.get("error").is_some())
}

fn anthropic_sse_block_is_semantic(block: &[u8]) -> bool {
    if raw_sse_block_is_comment(block) || upstream_sse_block_is_error(block) {
        return false;
    }
    let event = raw_responses_sse_event_name(block);
    !matches!(event.as_deref(), None | Some("message_start" | "ping"))
}

/// Reconnect raw Anthropic Messages SSE before the Responses converter.
///
/// Replay is allowed only before semantic output. Capacity and transport
/// failures use one shared retry budget; they only differ in classification
/// and delay. The converter retains its state across reconnects so repeated
/// scaffolding does not duplicate lifecycle events. Chat streams use their
/// dedicated wrapper below.
pub(crate) fn create_resilient_anthropic_upstream_sse_stream(
    initial: ByteStream,
    reconnector: Option<StreamReconnector>,
    capacity_retry_enabled: bool,
    log_context: Option<StreamLogContext>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let mut current = Some(initial);
        let mut semantic_output_seen = false;
        let mut retry_attempt = 0u32;
        let mut long_wait_capacity_mode = false;
        let mut scaffold_forwarded = false;

        'attempts: loop {
            let Some(mut stream) = current.take() else { break };
            let mut buffer = BytesMut::new();
            let mut swallowed_capacity_block: Option<Bytes> = None;
            let mut failure_reason: Option<String> = None;
            let mut silence = Duration::ZERO;

            'read: loop {
                let item = match tokio::time::timeout(KEEPALIVE_INTERVAL, stream.next()).await {
                    Ok(item) => {
                        silence = Duration::ZERO;
                        item
                    }
                    Err(_) => {
                        silence += KEEPALIVE_INTERVAL;
                        if scaffold_forwarded && silence <= UPSTREAM_SILENCE_KEEPALIVE_LIMIT {
                            yield Ok(Bytes::from_static(b": ping\n\n"));
                        }
                        continue;
                    }
                };
                let Some(item) = item else {
                    if !buffer.is_empty() {
                        // 不能验证残块是否只是脚手架；原样发出并关闭重放通道。
                        semantic_output_seen = true;
                        yield Ok(buffer.split().freeze());
                        break 'read;
                    } else if semantic_output_seen {
                        // A clean EOF after semantic output is owned by the
                        // downstream converter; do not reinterpret it as a
                        // pre-semantic retry failure.
                        break 'read;
                    } else {
                        failure_reason = Some("upstream SSE ended before semantic output".into());
                        break 'read;
                    }
                };
                let chunk = match item {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        if semantic_output_seen {
                            yield Err(error);
                            break 'attempts;
                        }
                        failure_reason =
                            Some(format!("upstream SSE transport error: {error}"));
                        break 'read;
                    }
                };
                buffer.extend_from_slice(&chunk);
                while let Some(block) = take_raw_sse_block(&mut buffer) {
                    let capacity_failure = capacity_retry_enabled
                        && !semantic_output_seen
                        && upstream_sse_block_is_error(&block)
                        && raw_responses_sse_payload(&block)
                            .as_ref()
                            .is_some_and(|payload| is_capacity_error_payload(payload, None));
                    if capacity_failure {
                        let long_wait_capacity = raw_responses_sse_payload(&block)
                            .as_ref()
                            .is_some_and(capacity_error_requires_long_wait);
                        long_wait_capacity_mode |= long_wait_capacity;
                        swallowed_capacity_block = Some(block);
                        failure_reason = Some("upstream reported model capacity pressure".into());
                        break 'read;
                    }
                    if matches!(
                        raw_responses_sse_event_name(&block).as_deref(),
                        Some("message_start")
                    ) {
                        scaffold_forwarded = true;
                    }
                    semantic_output_seen |= anthropic_sse_block_is_semantic(&block);
                    yield Ok(block);
                }
                if swallowed_capacity_block.is_some() {
                    break;
                }
            }

            let Some(mut reason) = failure_reason else {
                break;
            };
            let is_capacity_retry = swallowed_capacity_block.is_some();
            let Some(reconnector) = reconnector.as_ref() else {
                if let Some(capacity_block) = swallowed_capacity_block {
                    yield Ok(capacity_block);
                } else {
                    yield Err(std::io::Error::other(reason));
                }
                break;
            };
            if semantic_output_seen && !is_capacity_retry {
                yield Err(std::io::Error::other(reason));
                break;
            }

            let retry_limit = reconnector.retry_limit_for(is_capacity_retry);
            let reason_class = if is_capacity_retry {
                "capacity_pressure"
            } else {
                "stream_interrupted"
            };
            loop {
                if retry_attempt >= retry_limit {
                    let exhausted_class = if is_capacity_retry {
                        "capacity_retry_exhausted"
                    } else {
                        "transport_retry_exhausted"
                    };
                    emit_retry_activity(
                        log_context.as_ref(),
                        "anthropic_messages",
                        "retries_exhausted",
                        retry_attempt,
                        retry_limit,
                        Some(exhausted_class),
                    );
                    if let Some(capacity_block) = swallowed_capacity_block {
                        yield Ok(capacity_block);
                    } else {
                        yield Err(std::io::Error::other(reason));
                    }
                    break 'attempts;
                }

                retry_attempt += 1;
                emit_retry_activity(
                    log_context.as_ref(),
                    "anthropic_messages",
                    "retry_scheduled",
                    retry_attempt,
                    retry_limit,
                    Some(reason_class),
                );
                if is_capacity_retry {
                    if let Some(context) = log_context.as_ref() {
                        crate::proxy::codex_router_log::append_event(
                            "capacity_retry",
                            &[
                                ("stage", "AnthropicMessages".to_string()),
                                ("session", context.session_id.clone()),
                                ("model", context.model.clone()),
                                ("provider", context.provider_id.clone()),
                                ("attempt", retry_attempt.to_string()),
                            ],
                        );
                    }
                }
                if scaffold_forwarded {
                    yield Ok(Bytes::from_static(b": ping\n\n"));
                }
                let delay = if is_capacity_retry && long_wait_capacity_mode {
                    CAPACITY_RETRY_LONG_DELAY
                } else {
                    backoff_delay(retry_attempt)
                };
                let mut remaining = delay;
                while !remaining.is_zero() {
                    let slice = remaining.min(KEEPALIVE_INTERVAL);
                    tokio::time::sleep(slice).await;
                    remaining = remaining.saturating_sub(slice);
                    if !remaining.is_zero() && scaffold_forwarded {
                        yield Ok(Bytes::from_static(b": ping\n\n"));
                    }
                }
                match reconnector.connect().await {
                    Ok(response) if response.status().is_success() => {
                        emit_retry_activity(
                            log_context.as_ref(),
                            "anthropic_messages",
                            "reconnected",
                            retry_attempt,
                            retry_limit,
                            None,
                        );
                        current = Some(Box::pin(response.bytes_stream()));
                        continue 'attempts;
                    }
                    Ok(response) => {
                        let status = response.status();
                        reason = format!("reconnect got HTTP {} from upstream", status.as_u16());
                        emit_retry_activity(
                            log_context.as_ref(),
                            "anthropic_messages",
                            "reconnect_failed",
                            retry_attempt,
                            retry_limit,
                            Some("reconnect_http_failure"),
                        );
                        crate::proxy::error_journal::capture_discarded_response(response);
                    }
                    Err(error) => {
                        reason = format!("reconnect failed: {error}");
                        emit_retry_activity(
                            log_context.as_ref(),
                            "anthropic_messages",
                            "reconnect_failed",
                            retry_attempt,
                            retry_limit,
                            Some("reconnect_transport_failure"),
                        );
                    }
                }
            }
        }
    }
}

/// Codex CLI 的标称退避序列（无抖动）：200/400/800/1600/3200ms。
fn backoff_delay(attempt: u32) -> Duration {
    Duration::from_millis(200u64 << attempt.saturating_sub(1).min(4))
}

/// 从原始 Responses SSE 字节缓冲中取出一个完整事件（连同分隔空行）。
///
/// 不在 chunk 边界上作 UTF-8 解码，避免上游刚好在中文字符中间切块时篡改
/// passthrough 字节；只有取得完整 SSE block 后才用 UTF-8 读取事件名。
fn take_raw_sse_block(buffer: &mut BytesMut) -> Option<Bytes> {
    let bytes = buffer.as_ref();
    let boundary = bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| index + 2)
        .or_else(|| {
            bytes
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
        })?;
    Some(buffer.split_to(boundary).freeze())
}

/// 读取原始 Responses SSE block 的事件名；注释或不含事件名的 block 返回 `None`。
fn raw_responses_sse_event_name(block: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(block).ok()?;
    for line in text.lines() {
        if let Some(event) = strip_sse_field(line, "event") {
            return Some(event.trim().to_string());
        }
        if let Some(data) = strip_sse_field(line, "data") {
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                if let Some(kind) = value.get("type").and_then(Value::as_str) {
                    return Some(kind.to_string());
                }
            }
        }
    }
    None
}

fn raw_responses_sse_payload(block: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(block).ok()?;
    let data = text
        .lines()
        .filter_map(|line| strip_sse_field(line, "data"))
        .collect::<Vec<_>>()
        .join("\n");
    if data.trim().is_empty() || data.trim() == "[DONE]" {
        return None;
    }
    serde_json::from_str(&data).ok()
}

/// 判断上游错误是否明确属于模型容量/服务器过载，而不是额度、认证或一般参数错误。
///
/// 类型码是强信号；文案只接受明确的容量语义。泛化的 `please try again later`
/// 只有与 overload 类型或 5xx HTTP 状态组合时才成立，避免把业务错误误重放。
pub(crate) fn is_capacity_error_payload(payload: &Value, status: Option<http::StatusCode>) -> bool {
    let error = payload
        .pointer("/response/error")
        .or_else(|| payload.get("error"))
        .unwrap_or(payload);
    let error_type = error
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| error.get("code").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();

    let overload_type = [
        "server_is_overloaded",
        "slow_down",
        "overloaded_error",
        "model_at_capacity",
        "capacity_exceeded",
    ]
    .iter()
    .any(|marker| error_type.contains(marker));
    let explicit_capacity_message = [
        "selected model is at capacity",
        "model is at capacity",
        "servers are currently overloaded",
        "currently experiencing high demand",
    ]
    .iter()
    .any(|marker| message.contains(marker));
    let explicit_concurrency_message = [
        "concurrent limit reached",
        "concurrency limit reached",
        "concurrent request limit",
        "concurrent requests limit",
        "too many concurrent requests",
        "maximum concurrent requests",
    ]
    .iter()
    .any(|marker| message.contains(marker));
    let retry_later_with_server_signal = message.contains("please try again later")
        && (overload_type || status.is_some_and(|status| status.is_server_error()));

    overload_type
        || explicit_capacity_message
        || explicit_concurrency_message
        || retry_later_with_server_signal
}

/// Whether an otherwise replayable capacity error explicitly asks the caller
/// to wait for a high-demand/concurrency window to clear.
pub(crate) fn capacity_error_requires_long_wait(payload: &Value) -> bool {
    let error = payload
        .pointer("/response/error")
        .or_else(|| payload.get("error"))
        .unwrap_or(payload);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();

    [
        "currently experiencing high demand",
        "concurrent limit reached",
        "concurrency limit reached",
        "concurrent request limit",
        "concurrent requests limit",
        "too many concurrent requests",
        "maximum concurrent requests",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}

pub(crate) fn capacity_error_body_requires_long_wait(body: Option<&str>) -> bool {
    let Some(body) = body.filter(|body| !body.trim().is_empty()) else {
        return false;
    };
    let payload =
        serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({ "message": body }));
    capacity_error_requires_long_wait(&payload)
}

pub(crate) fn is_capacity_error_response(status: http::StatusCode, body: Option<&str>) -> bool {
    let server_load_status = matches!(
        status,
        http::StatusCode::BAD_GATEWAY
            | http::StatusCode::SERVICE_UNAVAILABLE
            | http::StatusCode::GATEWAY_TIMEOUT
    );
    let Some(body) = body.filter(|body| !body.trim().is_empty()) else {
        return server_load_status;
    };
    let payload =
        serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({ "message": body }));
    if is_capacity_error_payload(&payload, Some(status)) {
        return true;
    }

    server_load_status && !is_explicit_non_replayable_error_payload(&payload)
}

fn is_explicit_non_replayable_error_payload(payload: &Value) -> bool {
    let error = payload
        .pointer("/response/error")
        .or_else(|| payload.get("error"))
        .unwrap_or(payload);
    let kind = error
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| error.get("code").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();

    [
        "quota",
        "billing",
        "authentication",
        "unauthorized",
        "forbidden",
        "permission",
        "policy",
        "invalid_request",
        "invalid_parameter",
        "unsupported_parameter",
    ]
    .iter()
    .any(|marker| kind.contains(marker))
        || [
            "quota exhausted",
            "insufficient quota",
            "invalid token",
            "authentication failed",
            "request blocked by policy",
            "unsupported parameter",
        ]
        .iter()
        .any(|marker| message.contains(marker))
}

struct NativeResponsesSseErrorDiagnostic {
    event_name: String,
    error_type: String,
    message_class: &'static str,
    message_hash: String,
}

/// 从原生 Responses SSE 错误事件提取不含正文的诊断摘要。
///
/// 上游可能把错误放在 `/error`、`/response/error`，也可能只给事件名。日志只
/// 保存固定类别、受限 error type 和消息 hash，避免把 prompt、策略文本或 token
/// 写入本机日志。
fn native_responses_sse_error_diagnostic(
    block: &[u8],
) -> Option<NativeResponsesSseErrorDiagnostic> {
    let text = std::str::from_utf8(block).ok()?;
    let mut event_name = None;
    let mut data_lines = Vec::new();
    for line in text.lines() {
        if let Some(event) = strip_sse_field(line, "event") {
            event_name = Some(event.trim().to_string());
        } else if let Some(data) = strip_sse_field(line, "data") {
            data_lines.push(data);
        }
    }

    let value = serde_json::from_str::<Value>(&data_lines.join("\n")).ok();
    let event_name = event_name.or_else(|| {
        value
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })?;
    if !matches!(
        event_name.as_str(),
        "response.failed" | "error" | "response.error"
    ) {
        return None;
    }

    let error = value.as_ref().and_then(|value| {
        value
            .pointer("/response/error")
            .or_else(|| value.get("error"))
    });
    let error_type = error
        .and_then(|error| {
            error
                .get("type")
                .and_then(Value::as_str)
                .or_else(|| error.get("code").and_then(Value::as_str))
        })
        .map(sanitize_diagnostic_token)
        .unwrap_or_else(|| "upstream_error".to_string());
    let message = error
        .and_then(|error| error.get("message").and_then(Value::as_str))
        .or_else(|| {
            value
                .as_ref()
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    let lower = format!("{} {}", error_type, message).to_ascii_lowercase();
    let message_class = if lower.contains("policy")
        || lower.contains("safety")
        || lower.contains("moderation")
        || lower.contains("violat")
        || lower.contains("invalid prompt")
    {
        "policy_or_safety"
    } else {
        "upstream_error"
    };
    let digest = Sha256::digest(message.as_bytes());
    let message_hash = hex::encode(digest)[..16].to_string();

    Some(NativeResponsesSseErrorDiagnostic {
        event_name,
        error_type,
        message_class,
        message_hash,
    })
}

fn sanitize_diagnostic_token(value: &str) -> String {
    let token: String = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
        .take(64)
        .collect();
    if token.is_empty() {
        "upstream_error".to_string()
    } else {
        token
    }
}

fn log_native_responses_sse_error(context: &StreamLogContext, block: &[u8], attempt: u32) {
    let Some(diagnostic) = native_responses_sse_error_diagnostic(block) else {
        return;
    };
    if let Some(payload) = raw_responses_sse_payload(block) {
        let error = payload
            .pointer("/response/error")
            .or_else(|| payload.get("error"))
            .unwrap_or(&payload);
        crate::proxy::codex_error_capture::capture_at(
            &crate::config::get_app_config_dir(),
            &context.session_id,
            &diagnostic.event_name,
            error,
            chrono::Utc::now().timestamp(),
        );
    }
    crate::proxy::codex_router_log::append_event(
        "upstream_sse_error",
        &[
            ("stage", "native_responses".to_string()),
            ("session", context.session_id.clone()),
            ("model", context.model.clone()),
            ("provider", context.provider_id.clone()),
            ("event", diagnostic.event_name),
            ("error_type", diagnostic.error_type),
            ("message_class", diagnostic.message_class.to_string()),
            ("message_hash", diagnostic.message_hash),
            ("attempt", attempt.to_string()),
        ],
    );
}

fn native_responses_client_failure(block: Bytes, response_id: Option<&str>) -> Bytes {
    if !matches!(
        raw_responses_sse_event_name(&block).as_deref(),
        Some("error" | "response.error")
    ) {
        return block;
    }
    let Some(payload) = raw_responses_sse_payload(&block) else {
        return block;
    };
    let original = payload
        .pointer("/response/error")
        .or_else(|| payload.get("error"))
        .unwrap_or(&payload);
    if !original.is_object() {
        return block;
    }
    let mut error = serde_json::Map::new();
    for field in ["type", "code", "message", "param"] {
        if let Some(value) = original.get(field) {
            error.insert(field.to_string(), value.clone());
        }
    }
    let mut response = json!({"status":"failed","error":error});
    for field in ["id", "model", "usage"] {
        if let Some(value) = payload
            .get("response")
            .and_then(|response| response.get(field))
        {
            response[field] = value.clone();
        }
    }
    if let Some(id) = response_id {
        if response.get("id").and_then(Value::as_str).is_none() {
            response["id"] = json!(id);
        }
    }
    let mut failure = json!({"type":"response.failed","response":response});
    if let Some(sequence) = payload.get("sequence_number") {
        failure["sequence_number"] = sequence.clone();
    }
    Bytes::from(format!("event: response.failed\ndata: {failure}\n\n"))
}

fn raw_sse_block_is_comment(block: &[u8]) -> bool {
    block
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        == Some(b':')
}

fn native_responses_transport_error_message(error: &std::io::Error) -> &'static str {
    let chain = crate::proxy::error::error_chain_message(error).to_ascii_lowercase();
    if chain.contains("unexpected eof during chunk size line") {
        "上游响应流连接提前关闭（HTTP 分块响应未完整结束），请检查网络或代理后重试"
    } else if error.kind() == std::io::ErrorKind::TimedOut
        || chain.contains("timed out")
        || chain.contains("timeout")
    {
        "上游响应流读取超时，请检查网络或代理后重试"
    } else {
        "上游响应流传输中断，请检查网络或代理后重试"
    }
}

/// 中途截断 / 协议拒绝的终态事件：发 `event: response.failed`。
///
/// Codex 客户端按 JSON `type` 字段分派（而非 SSE 事件名）：裸 `event: error`
/// （kind="error"）在客户端无分支、被静默丢弃，客户端只能回退到通用的
/// "stream closed before response.completed"，这里记录的具体原因随之丢失。
/// `response.failed` 分支会读取 `response.error`；只要 `code` 不命中客户端的
/// 确定性分类（context_length_exceeded、insufficient_quota、cyber_policy 等），
/// 就会被映射为可重试的 stream error，并把具体 `message` 保留到
/// `stream_max_retries` 耗尽后呈现。因此本函数不得复用客户端分类的 code 值。
fn native_responses_failed_terminal_sse(
    response_id: Option<&str>,
    code: &str,
    message: &str,
) -> Bytes {
    let mut response = json!({
        "status": "failed",
        "error": {
            "code": code,
            "message": message,
        },
    });
    if let Some(id) = response_id {
        response["id"] = json!(id);
    }
    let payload = json!({
        "type": "response.failed",
        "response": response,
    });
    Bytes::from(format!("event: response.failed\ndata: {payload}\n\n"))
}

/// 原生 Codex Responses 的安全 SSE 重连。
///
/// 除上游错误终态兼容转换外保留协议字节。只有 `response.created` 和
/// SSE 注释已被发出时，重新执行同一上游请求仍可对客户端透明；任何其它事件
/// （包括 malformed block）都可能已经进入 Codex 持久化/工具状态机，立即封死
/// 重放路径。这样中途异常只会作为一次普通断流交给 Codex，而不会造成重复调用。
#[allow(dead_code)]
pub fn create_resilient_responses_sse_stream(
    initial: ByteStream,
    reconnector: Option<StreamReconnector>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    create_resilient_responses_sse_stream_with_context(initial, reconnector, None, true)
}

/// 原生 Responses SSE 透传的可观测版本：在不记录正文的前提下，把中途
/// `response.failed`/`error` 事件写入 CCSM router log，并保留原有重连语义。
pub(crate) fn create_resilient_responses_sse_stream_with_context(
    initial: ByteStream,
    reconnector: Option<StreamReconnector>,
    log_context: Option<StreamLogContext>,
    capacity_retry_enabled: bool,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let mut retry_attempt = 0;
        let mut created_forwarded = false;
        let mut response_id: Option<String> = None;
        let mut semantic_output_forwarded = false;
        let mut capacity_retry_long_wait_mode = false;
        let mut evidence = NativeResponsesEvidence::default();
        let mut current = Some(initial);

        'attempts: loop {
            let Some(mut stream) = current.take() else { break };
            let mut buffer = BytesMut::new();
            let mut silence = Duration::ZERO;

            let mut retrying_capacity = false;
            let mut reason = 'stream: loop {
                let item = match tokio::time::timeout(KEEPALIVE_INTERVAL, stream.next()).await {
                    Ok(item) => {
                        silence = Duration::ZERO;
                        item
                    }
                    Err(_) => {
                        silence += KEEPALIVE_INTERVAL;
                        if created_forwarded && silence <= UPSTREAM_SILENCE_KEEPALIVE_LIMIT {
                            yield Ok(Bytes::from_static(b": ping\n\n"));
                        }
                        continue;
                    }
                };

                let Some(item) = item else {
                    if !buffer.is_empty() {
                        // 不能验证残块是否只是脚手架；原样发出并关闭重放通道。
                        semantic_output_forwarded = true;
                        yield Ok(buffer.split().freeze());
                    }
                    if semantic_output_forwarded {
                        let message = "Upstream Responses SSE ended without a terminal event after semantic output";
                        log::error!("[Codex/Responses] {message}");
                        yield Ok(native_responses_failed_terminal_sse(
                            response_id.as_deref(),
                            "upstream_terminal_event_missing",
                            message,
                        ));
                        break 'attempts;
                    }
                    break 'stream "upstream Responses SSE ended before semantic output".into();
                };

                let chunk = match item {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        if semantic_output_forwarded {
                            let message = native_responses_transport_error_message(&error);
                            log::error!(
                                "[Codex/Responses] upstream stream failed after semantic output: {}; client_message={message}",
                                crate::proxy::error::error_chain_message(&error)
                            );
                            yield Ok(native_responses_failed_terminal_sse(
                                response_id.as_deref(),
                                "stream_error",
                                message,
                            ));
                            break 'attempts;
                        }
                        break 'stream format!("upstream Responses SSE transport error: {error}");
                    }
                };
                buffer.extend_from_slice(&chunk);

                while let Some(block) = take_raw_sse_block(&mut buffer) {
                    let event_name = raw_responses_sse_event_name(&block);
                    let payload = raw_responses_sse_payload(&block);
                    let terminal_disposition =
                        if let (Some(event_name), Some(payload)) =
                            (event_name.as_deref(), payload.as_ref())
                        {
                            evidence.observe_event(event_name, payload);
                            classify_native_responses_terminal(event_name, payload, evidence)
                        } else {
                            None
                        };
                    match (event_name.as_deref(), terminal_disposition) {
                        (Some("response.created"), _) if created_forwarded => {
                            // 新连接会再次宣告 response.created；客户端已经见过它。
                        }
                        (Some("response.created"), _) => {
                            created_forwarded = true;
                            response_id = payload.as_ref().and_then(|value| value.pointer("/response/id")).and_then(Value::as_str).map(str::to_string);
                            yield Ok(block);
                        }
                        (None, _) if raw_sse_block_is_comment(&block) => {
                            yield Ok(block);
                        }
                        (Some(_), Some(disposition)) => {
                            if let Some(context) = log_context.as_ref() {
                                log_native_responses_sse_error(
                                    context,
                                    &block,
                                    retry_attempt,
                                );
                            }
                            match disposition {
                                NativeResponsesTerminalDisposition::Completed
                                | NativeResponsesTerminalDisposition::Incomplete => {
                                    yield Ok(block);
                                }
                                NativeResponsesTerminalDisposition::Failed => {
                                    if capacity_retry_enabled
                                        && !semantic_output_forwarded
                                        && payload.as_ref().is_some_and(|payload| {
                                            is_capacity_error_payload(payload, None)
                                        })
                                    {
                                        capacity_retry_long_wait_mode |= payload
                                            .as_ref()
                                            .is_some_and(capacity_error_requires_long_wait);
                                        retrying_capacity = true;
                                        break 'stream "upstream reported model capacity pressure".into();
                                    }
                                    yield Ok(native_responses_client_failure(block, response_id.as_deref()));
                                }
                                NativeResponsesTerminalDisposition::ProtocolError {
                                    code,
                                    message,
                                } => {
                                    log::error!(
                                        "[Codex/Responses] rejected invalid terminal event: code={code}; {message}"
                                    );
                                    yield Ok(native_responses_failed_terminal_sse(
                                        response_id.as_deref(),
                                        code,
                                        &message,
                                    ));
                                }
                            }
                            break 'attempts;
                        }
                        _ => {
                            semantic_output_forwarded = true;
                            yield Ok(block);
                        }
                    }
                }
            };

            loop {
                let Some(reconnector) = reconnector.as_ref() else {
                    let message = if semantic_output_forwarded {
                        "Upstream Responses SSE ended without a terminal event after semantic output"
                    } else {
                        "Upstream Responses SSE ended without a terminal event"
                    };
                    log::error!("[Codex/Responses] {message}: {reason}");
                    yield Ok(native_responses_failed_terminal_sse(
                        response_id.as_deref(),
                        "upstream_terminal_event_missing",
                        message,
                    ));
                    break 'attempts;
                };
                let retry_limit = reconnector.retry_limit_for(retrying_capacity);
                if retry_attempt >= retry_limit {
                    let message = if retrying_capacity {
                        "上游模型持续处于容量压力，自动续跑次数已耗尽，请稍后重试"
                    } else {
                        "上游响应流在输出正文前反复中断，自动重连已耗尽，请检查网络或代理后重试"
                    };
                    emit_retry_activity(
                        log_context.as_ref(),
                        "native_responses",
                        "retries_exhausted",
                        retry_attempt,
                        retry_limit,
                        Some(if retrying_capacity {
                            "capacity_retry_exhausted"
                        } else {
                            "transport_retry_exhausted"
                        }),
                    );
                    log::error!(
                        "[Codex/Responses] stream failed after {retry_attempt} reconnect attempt(s): {reason}; client_message={message}"
                    );
                    yield Ok(native_responses_failed_terminal_sse(
                        response_id.as_deref(),
                        if retrying_capacity { "capacity_retry_exhausted" } else { "stream_error" },
                        message,
                    ));
                    break 'attempts;
                }
                retry_attempt += 1;
                if retrying_capacity {
                    log::warn!(
                        "[Codex/Responses] upstream capacity pressure before semantic output; reconnecting (attempt {retry_attempt}/{retry_limit})"
                    );
                } else {
                    log::warn!(
                        "[Codex/Responses] upstream stream dropped before semantic output ({reason}); reconnecting (attempt {retry_attempt}/{retry_limit})"
                    );
                }
                emit_retry_activity(
                    log_context.as_ref(),
                    "native_responses",
                    "retry_scheduled",
                    retry_attempt,
                    retry_limit,
                    Some(if retrying_capacity {
                        "capacity_pressure"
                    } else {
                        "stream_interrupted"
                    }),
                );
                if created_forwarded {
                    yield Ok(Bytes::from_static(b": ping\n\n"));
                }
                let delay = if retrying_capacity && capacity_retry_long_wait_mode {
                    CAPACITY_RETRY_LONG_DELAY
                } else {
                    backoff_delay(retry_attempt)
                };
                let mut remaining = delay;
                while !remaining.is_zero() {
                    let slice = remaining.min(KEEPALIVE_INTERVAL);
                    tokio::time::sleep(slice).await;
                    remaining = remaining.saturating_sub(slice);
                    if !remaining.is_zero() && created_forwarded {
                        yield Ok(Bytes::from_static(b": ping\n\n"));
                    }
                }
                match reconnector.connect().await {
                    Ok(response) if response.status().is_success() => {
                        emit_retry_activity(
                            log_context.as_ref(),
                            "native_responses",
                            "reconnected",
                            retry_attempt,
                            retry_limit,
                            None,
                        );
                        current = Some(Box::pin(response.bytes_stream()));
                        continue 'attempts;
                    }
                    Ok(response) => {
                        reason = format!("reconnect got HTTP {} from upstream", response.status().as_u16());
                        emit_retry_activity(
                            log_context.as_ref(),
                            "native_responses",
                            "reconnect_failed",
                            retry_attempt,
                            retry_limit,
                            Some("reconnect_http_failure"),
                        );
                        crate::proxy::error_journal::capture_discarded_response(response);
                    }
                    Err(error) => {
                        emit_retry_activity(
                            log_context.as_ref(),
                            "native_responses",
                            "reconnect_failed",
                            retry_attempt,
                            retry_limit,
                            Some("reconnect_transport_failure"),
                        );
                        reason = format!("reconnect failed: {error}");
                    }
                }
            }
        }
    }
}

/// Chat Completions SSE 的安全重连。
///
/// OpenCode/OpenAI-compatible 上游通常不提供 Responses SSE，而是返回
/// Chat Completions SSE。该包装器在尚未向下游转发任何实质 Chat 内容前，
/// 允许重新执行同一上游请求；role-only 首块视为协议脚手架，重连后只保留一次。
pub(crate) fn create_resilient_chat_sse_stream_with_context(
    initial: ByteStream,
    reconnector: Option<StreamReconnector>,
    log_context: Option<StreamLogContext>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let mut attempt = 0;
        let mut current = Some(initial);
        let mut scaffold_forwarded = false;
        let mut semantic_output_forwarded = false;
        let mut capacity_long_wait_mode = false;

        'attempts: loop {
            let Some(mut stream) = current.take() else { break };
            let mut buffer = BytesMut::new();
            let mut silence = Duration::ZERO;
            let mut failure: Option<(String, String)> = None;
            let mut terminal = false;

            loop {
                let item = match tokio::time::timeout(KEEPALIVE_INTERVAL, stream.next()).await {
                    Ok(item) => {
                        silence = Duration::ZERO;
                        item
                    }
                    Err(_) => {
                        silence += KEEPALIVE_INTERVAL;
                        if scaffold_forwarded && silence <= UPSTREAM_SILENCE_KEEPALIVE_LIMIT {
                            yield Ok(Bytes::from_static(b": ping\n\n"));
                        }
                        continue;
                    }
                };

                let Some(item) = item else {
                    if !buffer.is_empty() {
                        semantic_output_forwarded = true;
                        yield Ok(buffer.split().freeze());
                        failure = Some((
                            "residual_before_terminal".to_string(),
                            "upstream Chat Completions SSE ended with an unparsed residual block".to_string(),
                        ));
                    } else if !terminal && !semantic_output_forwarded {
                        failure = Some((
                            "premature_eof".to_string(),
                            "upstream Chat Completions SSE ended before semantic output".to_string(),
                        ));
                    }
                    break;
                };

                let chunk = match item {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        if semantic_output_forwarded {
                            let message = native_responses_transport_error_message(&error);
                            log::error!(
                                "[Chat/Completions] upstream stream failed after semantic output: {}; client_message={message}",
                                crate::proxy::error::error_chain_message(&error)
                            );
                            if let Some(context) = log_context.as_ref() {
                                log_chat_stream_drop(
                                    context,
                                    "transport_error_after_semantic_output",
                                    &crate::proxy::error::error_chain_message(&error),
                                    attempt,
                                );
                            }
                            yield Ok(chat_transport_error_sse(message));
                            terminal = true;
                        } else {
                            failure = Some((
                                "transport_error".to_string(),
                                format!("upstream Chat Completions SSE transport error: {error}"),
                            ));
                        }
                        break;
                    }
                };
                buffer.extend_from_slice(&chunk);

                while let Some(block) = take_raw_sse_block(&mut buffer) {
                    match classify_chat_sse_block(&block) {
                        ChatSseBlockDisposition::Ignore => {}
                        ChatSseBlockDisposition::Comment => yield Ok(block),
                        ChatSseBlockDisposition::Done => {
                            terminal = true;
                            yield Ok(block);
                            break;
                        }
                        ChatSseBlockDisposition::Error => {
                            if let Some(context) = log_context.as_ref() {
                                log_chat_upstream_error(context, &block, attempt);
                            }
                            if !semantic_output_forwarded
                                && reconnector.as_ref().is_some_and(|reconnector| {
                                    reconnector.capacity_retry_enabled && reconnector.retry_limit() > 0
                                })
                                && raw_responses_sse_payload(&block)
                                    .as_ref()
                                    .is_some_and(|payload| is_capacity_error_payload(payload, None))
                            {
                                let reason_class = if raw_responses_sse_payload(&block)
                                    .as_ref()
                                    .is_some_and(capacity_error_requires_long_wait)
                                {
                                    capacity_long_wait_mode = true;
                                    "capacity_error_long_wait"
                                } else {
                                    "capacity_error"
                                };
                                failure = Some((
                                    reason_class.to_string(),
                                    "upstream Chat SSE reported temporary capacity exhaustion".to_string(),
                                ));
                                break;
                            }
                            semantic_output_forwarded = true;
                            terminal = true;
                            yield Ok(block);
                            break;
                        }
                        ChatSseBlockDisposition::Scaffold => {
                            // role-only chunk 只用于建立流生命周期；重连后的重复首块必须抑制。
                            if !scaffold_forwarded {
                                scaffold_forwarded = true;
                                yield Ok(block);
                            }
                        }
                        ChatSseBlockDisposition::Semantic => {
                            semantic_output_forwarded = true;
                            yield Ok(block);
                        }
                    }
                }

                if failure.is_some() || terminal {
                    break;
                }
            }

            if terminal {
                break 'attempts;
            }

            if let Some((mut reason_class, reason)) = failure {
                if semantic_output_forwarded {
                    let message = "上游 Chat Completions 响应流在输出正文后中断，无法安全自动重放";
                    log::error!("[Chat/Completions] {message}: {reason}");
                    if let Some(context) = log_context.as_ref() {
                        log_chat_stream_drop(
                            context,
                            "dropped_after_semantic_output",
                            &reason,
                            attempt,
                        );
                    }
                    yield Ok(chat_transport_error_sse(message));
                    break 'attempts;
                }

                let Some(reconnector) = reconnector.as_ref() else {
                    let message = "上游 Chat Completions 响应流在输出正文前中断";
                    log::error!("[Chat/Completions] stream dropped without reconnector ({reason})");
                    if let Some(context) = log_context.as_ref() {
                        log_chat_stream_drop(context, &reason_class, &reason, attempt);
                    }
                    yield Ok(chat_transport_error_sse(message));
                    break 'attempts;
                };

                let mut reason = reason;
                let capacity_retry = reason_class.starts_with("capacity_error");
                loop {
                    let effective_max_retries = reconnector.retry_limit_for(capacity_retry);
                    if attempt >= effective_max_retries {
                        let message = if capacity_retry {
                            "上游 Chat Completions 持续处于容量压力，自动重连已耗尽，请稍后重试"
                        } else {
                            "上游 Chat Completions 响应流反复中断，自动重连已耗尽，请检查网络或代理后重试"
                        };
                        log::error!(
                            "[Chat/Completions] stream failed after {attempt} reconnect attempt(s): {reason}"
                        );
                        emit_retry_activity(
                            log_context.as_ref(),
                            "chat_completions",
                            "retries_exhausted",
                            attempt,
                            effective_max_retries,
                            Some(reason_class.as_str()),
                        );
                        if let Some(context) = log_context.as_ref() {
                            log_chat_stream_drop(context, "retries_exhausted", &reason, attempt);
                        }
                        yield Ok(chat_retries_exhausted_error_sse(message));
                        break 'attempts;
                    }

                    attempt = attempt.saturating_add(1);
                    emit_retry_activity(
                        log_context.as_ref(),
                        "chat_completions",
                        "retry_scheduled",
                        attempt,
                        effective_max_retries,
                        Some(reason_class.as_str()),
                    );
                    if effective_max_retries == u32::MAX {
                        log::warn!(
                            "[Chat/Completions] upstream stream dropped before semantic output ({reason}); reconnecting (relentless attempt {attempt})"
                        );
                    } else {
                        log::warn!(
                            "[Chat/Completions] upstream stream dropped before semantic output ({reason}); reconnecting (attempt {attempt}/{effective_max_retries})"
                        );
                    }
                    if let Some(context) = log_context.as_ref() {
                        log_chat_stream_drop(context, "retry_scheduled", &reason, attempt);
                    }
                    if scaffold_forwarded {
                        yield Ok(Bytes::from_static(b": ping\n\n"));
                    }
                    let delay = if capacity_retry && capacity_long_wait_mode {
                        CAPACITY_RETRY_LONG_DELAY
                    } else {
                        backoff_delay(attempt)
                    };
                    let mut remaining = delay;
                    while !remaining.is_zero() {
                        let slice = remaining.min(KEEPALIVE_INTERVAL);
                        tokio::time::sleep(slice).await;
                        remaining = remaining.saturating_sub(slice);
                        if !remaining.is_zero() && scaffold_forwarded {
                            yield Ok(Bytes::from_static(b": ping\n\n"));
                        }
                    }
                    match reconnector.connect().await {
                        Ok(response) if response.status().is_success() => {
                            emit_retry_activity(
                                log_context.as_ref(),
                                "chat_completions",
                                "reconnected",
                                attempt,
                                effective_max_retries,
                                None,
                            );
                            current = Some(Box::pin(response.bytes_stream()));
                            continue 'attempts;
                        }
                        Ok(response) => {
                            reason = format!(
                                "reconnect got HTTP {} from upstream",
                                response.status().as_u16()
                            );
                            reason_class = "reconnect_http_failure".into();
                            emit_retry_activity(
                                log_context.as_ref(),
                                "chat_completions",
                                "reconnect_failed",
                                attempt,
                                effective_max_retries,
                                Some(reason_class.as_str()),
                            );
                            crate::proxy::error_journal::capture_discarded_response(response);
                        }
                        Err(error) => {
                            reason = format!("reconnect failed: {error}");
                            reason_class = "reconnect_transport_failure".into();
                            emit_retry_activity(
                                log_context.as_ref(),
                                "chat_completions",
                                "reconnect_failed",
                                attempt,
                                effective_max_retries,
                                Some(reason_class.as_str()),
                            );
                        }
                    }
                }
            }
        }
    }
}

enum ChatSseBlockDisposition {
    Ignore,
    Comment,
    Scaffold,
    Semantic,
    Done,
    Error,
}

/// 按 OpenAI Chat Completions 语义保守分类一个完整 SSE block。
fn classify_chat_sse_block(block: &[u8]) -> ChatSseBlockDisposition {
    let text = match std::str::from_utf8(block) {
        Ok(text) => text,
        Err(_) => return ChatSseBlockDisposition::Semantic,
    };
    if text
        .lines()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| line.starts_with(':'))
    {
        return ChatSseBlockDisposition::Comment;
    }

    let mut event_name = None;
    let mut data_lines = Vec::new();
    for line in text.lines() {
        if let Some(event) = strip_sse_field(line, "event") {
            event_name = Some(event.trim().to_string());
        } else if let Some(data) = strip_sse_field(line, "data") {
            data_lines.push(data.to_string());
        }
    }

    let Some(data) = data_lines.first() else {
        return ChatSseBlockDisposition::Ignore;
    };
    let joined = data_lines.join("\n");
    let _ = data;
    if joined.trim() == "[DONE]" {
        return ChatSseBlockDisposition::Done;
    }

    let value = match serde_json::from_str::<Value>(&joined) {
        Ok(value) => value,
        Err(_) => return ChatSseBlockDisposition::Semantic,
    };
    if event_name.as_deref() == Some("error") || value.get("error").is_some_and(|e| !e.is_null()) {
        return ChatSseBlockDisposition::Error;
    }

    let has_semantic_choice =
        value
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    let finish_reason = choice.get("finish_reason").is_some_and(|v| !v.is_null());
                    let delta_semantic = choice.get("delta").is_some_and(|delta| {
                        delta.as_object().is_some_and(|delta| {
                            delta.iter().any(|(key, value)| match value {
                                Value::Null => false,
                                Value::String(text) => key != "role" && !text.is_empty(),
                                _ => key != "role",
                            })
                        })
                    });
                    let message_semantic = choice.get("message").is_some_and(|message| {
                        message.as_object().is_some_and(|message| {
                            message.iter().any(|(key, value)| match value {
                                Value::Null => false,
                                Value::String(text) => key != "role" && !text.is_empty(),
                                _ => key != "role",
                            })
                        })
                    });
                    finish_reason || delta_semantic || message_semantic
                })
            });
    if has_semantic_choice {
        return ChatSseBlockDisposition::Semantic;
    }

    let known_scaffold_keys = [
        "id",
        "object",
        "created",
        "model",
        "choices",
        "system_fingerprint",
        "service_tier",
    ];
    let unknown_top_level = value.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|key| !known_scaffold_keys.contains(&key.as_str()))
    });
    if unknown_top_level {
        return ChatSseBlockDisposition::Semantic;
    }
    ChatSseBlockDisposition::Scaffold
}

fn chat_transport_error_sse(message: &str) -> Bytes {
    chat_stream_error_sse(message, "ccswitch_chat_stream_interrupted")
}

fn chat_retries_exhausted_error_sse(message: &str) -> Bytes {
    chat_stream_error_sse(message, "ccswitch_chat_stream_retries_exhausted")
}

fn chat_stream_error_sse(message: &str, code: &'static str) -> Bytes {
    let payload = json!({
        "error": {
            "type": "stream_error",
            "code": code,
            "retryable": true,
            "message": message,
        }
    });
    // OpenAI-compatible clients use the DONE sentinel to close their SSE
    // parser even when the final data event is an error.
    Bytes::from(format!("event: error\ndata: {payload}\n\ndata: [DONE]\n\n"))
}

fn chat_drop_message_hash(reason: &str) -> String {
    let digest = Sha256::digest(reason.as_bytes());
    hex::encode(digest)[..16].to_string()
}

fn log_chat_stream_drop(
    context: &StreamLogContext,
    reason_class: &str,
    reason: &str,
    attempt: u32,
) {
    crate::proxy::codex_router_log::append_event(
        "upstream_sse_drop",
        &[
            ("stage", "chat_completions".to_string()),
            ("session", context.session_id.clone()),
            ("model", context.model.clone()),
            ("provider", context.provider_id.clone()),
            ("reason_class", reason_class.to_string()),
            ("message_hash", chat_drop_message_hash(reason)),
            ("attempt", attempt.to_string()),
        ],
    );
}

fn log_chat_upstream_error(context: &StreamLogContext, block: &[u8], attempt: u32) {
    if let Some(diagnostic) = native_responses_sse_error_diagnostic(block) {
        crate::proxy::codex_router_log::append_event(
            "upstream_sse_error",
            &[
                ("stage", "chat_completions".to_string()),
                ("session", context.session_id.clone()),
                ("model", context.model.clone()),
                ("provider", context.provider_id.clone()),
                ("event", diagnostic.event_name),
                ("error_type", diagnostic.error_type),
                ("message_class", diagnostic.message_class.to_string()),
                ("message_hash", diagnostic.message_hash),
                ("attempt", attempt.to_string()),
            ],
        );
    }
}

/// 单个转换器输出块里解析出的 Anthropic SSE 事件。
struct ScannedEvent {
    name: &'static str,
    data: Option<Value>,
    /// 事件在原始块文本中的完整片段（含结尾空行），用于选择性转发。
    raw: String,
}

/// 转换器产出的块都是本进程自己构造的 `event: X\ndata: {...}\n\n` 文本；
/// 这里做一次浅解析以便分类。解析失败的片段按"实质内容"保守处理。
fn scan_chunk(chunk: &str) -> Vec<ScannedEvent> {
    let mut buffer = chunk.to_string();
    let mut events = Vec::new();
    while let Some(block) = take_sse_block(&mut buffer) {
        if block.trim().is_empty() {
            continue;
        }
        let mut name = "";
        let mut data_lines: Vec<&str> = Vec::new();
        for line in block.lines() {
            if let Some(event) = strip_sse_field(line, "event") {
                name = event.trim();
            } else if let Some(data) = strip_sse_field(line, "data") {
                data_lines.push(data);
            }
        }
        let data = serde_json::from_str::<Value>(&data_lines.join("\n")).ok();
        let name = if name.is_empty() {
            data.as_ref()
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("")
        } else {
            name
        };
        // 分类只关心这四种身份，映射为静态名以避免借用局部 buffer。
        let name_owned: &'static str = match name {
            "message_start" => "message_start",
            "ping" => "ping",
            "error" => "error",
            _ => "",
        };
        events.push(ScannedEvent {
            name: name_owned,
            data,
            raw: format!("{block}\n\n"),
        });
    }
    // 转换器只产出完整块；万一出现残块，按实质内容原样转发，绝不吞字节。
    if !buffer.is_empty() {
        events.push(ScannedEvent {
            name: "",
            data: None,
            raw: buffer,
        });
    }
    events
}

/// 只把携带 [`RETRYABLE_STREAM_MARKER`] 注释行的错误事件视为可重试。
///
/// 该标记仅由本进程的转换器在传输层中断（`stream_error`）与无终止事件的
/// 过早 EOF（`stream_truncated`）时附加。不能改判 `error.type`：上游语义性
/// 失败的 type 逐字透传自上游可控字段，恰好叫 "stream_error" 时会被误吸收。
fn is_retryable_error_event(event: &ScannedEvent) -> bool {
    event.name == "error"
        && event
            .raw
            .lines()
            .any(|line| line == RETRYABLE_STREAM_MARKER)
}

fn retry_failure_reason(event: &ScannedEvent) -> String {
    event
        .data
        .as_ref()
        .and_then(|data| data.pointer("/error/message"))
        .and_then(Value::as_str)
        .unwrap_or("Responses upstream stream failed")
        .to_string()
}

/// 把 Responses 上游字节流转换为 Anthropic SSE，并在下游只收到协议脚手架
/// （`message_start`/`ping`）时对可重试的流中断做有界自动重连。
///
/// 无论是否带 `reconnector`，`message_start` 之后上游每静默
/// [`KEEPALIVE_INTERVAL`] 就向下游发一次 ping（推理模型隐藏思考期间上游可
/// 整段无事件），至多持续 [`UPSTREAM_SILENCE_KEEPALIVE_LIMIT`]。除此之外，
/// `reconnector` 为 `None` 时行为与 `create_anthropic_sse_stream_from_responses`
/// 完全一致。
pub(crate) fn create_resilient_anthropic_sse_stream_from_responses_with_web_search_options_and_context(
    initial: ByteStream,
    reconnector: Option<StreamReconnector>,
    hosted_web_search_name: Option<String>,
    max_web_search_uses: Option<u64>,
    log_context: Option<StreamLogContext>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let Some(reconnector) = reconnector else {
            // 无重连工厂：不做重试，但思考期心跳与主循环保持同款语义。
            let translated = create_anthropic_sse_stream_from_responses_with_web_search_options(
                initial,
                hosted_web_search_name.clone(),
                max_web_search_uses,
            );
            futures::pin_mut!(translated);
            let mut message_start_forwarded = false;
            loop {
                let mut silent = Duration::ZERO;
                let next = loop {
                    match tokio::time::timeout(KEEPALIVE_INTERVAL, translated.next()).await {
                        Ok(item) => break item,
                        Err(_) => {
                            silent += KEEPALIVE_INTERVAL;
                            if message_start_forwarded
                                && silent <= UPSTREAM_SILENCE_KEEPALIVE_LIMIT
                            {
                                yield Ok(anthropic_sse("ping", &json!({"type": "ping"})));
                            }
                        }
                    }
                };
                let Some(item) = next else { break };
                if let Ok(chunk) = &item {
                    if !message_start_forwarded
                        && scan_chunk(&String::from_utf8_lossy(chunk))
                            .iter()
                            .any(|event| event.name == "message_start")
                    {
                        message_start_forwarded = true;
                    }
                }
                yield item;
            }
            return;
        };

        let mut attempt: u32 = 0;
        let mut message_start_forwarded = false;
        let mut content_forwarded = false;
        let mut current: Option<ByteStream> = Some(initial);

        'attempts: loop {
            let byte_stream = match current.take() {
                Some(stream) => stream,
                None => break,
            };
            let translated = create_anthropic_sse_stream_from_responses_with_web_search_options(
                byte_stream,
                hosted_web_search_name.clone(),
                max_web_search_uses,
            );
            futures::pin_mut!(translated);

            // 本次尝试因可重试原因终止时的描述；None 表示尝试正常走完。
            let mut fail_reason: Option<String> = None;
            // 重连后的尝试对首个转换事件套用首包超时，防止上游连上后静默挂起。
            let mut awaiting_first_item = attempt > 0;

            loop {
                let next = if awaiting_first_item && !reconnector.first_byte_timeout.is_zero() {
                    let deadline =
                        tokio::time::Instant::now() + reconnector.first_byte_timeout;
                    let mut result = None;
                    let mut timed_out = true;
                    while tokio::time::Instant::now() < deadline {
                        let tick =
                            KEEPALIVE_INTERVAL.min(deadline - tokio::time::Instant::now());
                        match tokio::time::timeout(tick, translated.next()).await {
                            Ok(item) => {
                                result = item;
                                timed_out = false;
                                break;
                            }
                            Err(_) => {
                                if message_start_forwarded
                                    && tokio::time::Instant::now() < deadline
                                {
                                    yield Ok(anthropic_sse("ping", &json!({"type": "ping"})));
                                }
                            }
                        }
                    }
                    if timed_out {
                        fail_reason = Some(format!(
                            "reconnected stream produced no output within {}s",
                            reconnector.first_byte_timeout.as_secs()
                        ));
                        break;
                    }
                    result
                } else {
                    // 正常流转期间的思考期心跳：上游静默时周期性向下游发 ping
                    // （Anthropic 协议允许任意时刻出现 ping），超过
                    // UPSTREAM_SILENCE_KEEPALIVE_LIMIT 后停发，让外层空闲超时接管。
                    let mut silent = Duration::ZERO;
                    loop {
                        match tokio::time::timeout(KEEPALIVE_INTERVAL, translated.next()).await {
                            Ok(item) => break item,
                            Err(_) => {
                                silent += KEEPALIVE_INTERVAL;
                                if message_start_forwarded
                                    && silent <= UPSTREAM_SILENCE_KEEPALIVE_LIMIT
                                {
                                    yield Ok(anthropic_sse("ping", &json!({"type": "ping"})));
                                }
                            }
                        }
                    }
                };
                let Some(item) = next else {
                    break;
                };
                awaiting_first_item = false;

                let chunk = match item {
                    Ok(chunk) => chunk,
                    // 当前转换器从不产出 Err；防御性透传并终止。
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                };
                let text = String::from_utf8_lossy(&chunk);
                let mut forward = String::new();
                for event in scan_chunk(&text) {
                    if !content_forwarded && is_retryable_error_event(&event) {
                        fail_reason = Some(retry_failure_reason(&event));
                        break;
                    }
                    if event.name == "message_start" {
                        if message_start_forwarded {
                            // 重连后的新一轮生成会重新产生 message_start；
                            // 客户端已收到首轮的，抑制重复。
                            continue;
                        }
                        message_start_forwarded = true;
                    } else if event.name != "ping" {
                        content_forwarded = true;
                    }
                    forward.push_str(&event.raw);
                }
                if !forward.is_empty() {
                    yield Ok(Bytes::from(forward));
                }
                if fail_reason.is_some() {
                    break;
                }
            }

            let Some(mut reason) = fail_reason else {
                // 尝试正常结束（成功完成，或不可重试的错误已透传）。
                break 'attempts;
            };

            loop {
                let retry_limit = reconnector.retry_limit();
                if attempt >= retry_limit {
                    emit_retry_activity(
                        log_context.as_ref(),
                        "anthropic_messages",
                        "retries_exhausted",
                        attempt,
                        retry_limit,
                        Some("transport_retry_exhausted"),
                    );
                    log::error!(
                        "[Claude/Responses] stream failed after {attempt} reconnect attempt(s): {reason}"
                    );
                    yield Ok(anthropic_error_sse(
                        &format!(
                            "Responses upstream stream failed after {attempt} reconnect attempt(s): {reason}"
                        ),
                        "stream_error",
                    ));
                    break 'attempts;
                }
                attempt += 1;
                log::warn!(
                    "[Claude/Responses] upstream stream dropped before any content reached the client ({reason}); reconnecting (attempt {attempt}/{retry_limit})"
                );
                emit_retry_activity(
                    log_context.as_ref(),
                    "anthropic_messages",
                    "retry_scheduled",
                    attempt,
                    retry_limit,
                    Some("stream_interrupted"),
                );
                if message_start_forwarded {
                    // 喂一下下游的空闲计时器（Anthropic 协议允许任意时刻出现 ping）。
                    yield Ok(anthropic_sse("ping", &json!({"type": "ping"})));
                }
                tokio::time::sleep(backoff_delay(attempt)).await;
                let connect_result = {
                    let connect = reconnector.connect();
                    futures::pin_mut!(connect);
                    loop {
                        match tokio::time::timeout(KEEPALIVE_INTERVAL, connect.as_mut()).await {
                            Ok(result) => break result,
                            Err(_) => {
                                if message_start_forwarded {
                                    yield Ok(anthropic_sse("ping", &json!({"type": "ping"})));
                                }
                            }
                        }
                    }
                };
                match connect_result {
                    Ok(response) if response.status().is_success() => {
                        emit_retry_activity(
                            log_context.as_ref(),
                            "anthropic_messages",
                            "reconnected",
                            attempt,
                            retry_limit,
                            None,
                        );
                        current = Some(Box::pin(response.bytes_stream()));
                        continue 'attempts;
                    }
                    Ok(response) => {
                        reason = format!(
                            "reconnect got HTTP {} from upstream",
                            response.status().as_u16()
                        );
                        emit_retry_activity(
                            log_context.as_ref(),
                            "anthropic_messages",
                            "reconnect_failed",
                            attempt,
                            retry_limit,
                            Some("reconnect_http_failure"),
                        );
                        crate::proxy::error_journal::capture_discarded_response(response);
                    }
                    Err(error) => {
                        emit_retry_activity(
                            log_context.as_ref(),
                            "anthropic_messages",
                            "reconnect_failed",
                            attempt,
                            retry_limit,
                            Some("reconnect_transport_failure"),
                        );
                        reason = format!("reconnect failed: {error}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_error_normalization_retains_response_metadata() {
        let payload = json!({"type":"response.error","response":{"id":"resp-upstream","model":"model-a","usage":{"input_tokens":10,"output_tokens":5},"error":{"code":"server_error","message":"failed"}}});
        let block = Bytes::from(format!("event: response.error\ndata: {payload}\n\n"));
        let normalized = native_responses_client_failure(block, Some("resp-created"));
        let result = raw_responses_sse_payload(&normalized).unwrap();
        assert_eq!(result["response"]["id"], "resp-upstream");
        assert_eq!(result["response"]["model"], "model-a");
        assert_eq!(result["response"]["usage"]["input_tokens"], 10);
    }
    use futures::stream;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    fn create_resilient_anthropic_sse_stream_from_responses(
        initial: ByteStream,
        reconnector: Option<StreamReconnector>,
    ) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
        create_resilient_anthropic_sse_stream_from_responses_with_web_search_options_and_context(
            initial,
            reconnector,
            None,
            None,
            None,
        )
    }

    fn sse(event: &str, data: Value) -> String {
        format!("event: {event}\ndata: {data}\n\n")
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_error_preserves_cause_in_client_terminal_without_proxy_retry() {
        for (event, payload) in [
            (
                "error",
                json!({"type":"error","error":{"type":"invalid_request_error","code":"invalid_prompt","message":"request rejected","param":"input"}}),
            ),
            (
                "response.error",
                json!({"type":"response.error","code":"server_error","message":"temporarily unavailable","param":null}),
            ),
        ] {
            let (reconnector, calls) = scripted_reconnector(vec![]);
            let first = ok_chunks(&[created().as_str(), sse(event, payload.clone()).as_str()]);
            let out = collect(create_resilient_responses_sse_stream(
                first,
                Some(reconnector),
            ))
            .await;
            let failed = out
                .split("\n\n")
                .find(|block| block.starts_with("event: response.failed"))
                .expect(
                    "Codex needs a response.failed terminal instead of an unhandled generic error",
                );
            let data: Value = serde_json::from_str(failed.split_once("data: ").unwrap().1).unwrap();
            let original = payload.get("error").unwrap_or(&payload);
            assert_eq!(data["response"]["error"]["code"], original["code"]);
            assert_eq!(data["response"]["error"]["message"], original["message"]);
            assert_eq!(data["response"]["error"]["param"], original["param"]);
            assert_eq!(data["response"]["status"], "failed");
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(!out.contains("event: response.completed"));
        }
    }

    fn created() -> String {
        sse(
            "response.created",
            json!({"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}),
        )
    }

    fn text_delta(text: &str) -> String {
        sse(
            "response.output_text.delta",
            json!({"type":"response.output_text.delta","delta": text}),
        )
    }

    fn completed() -> String {
        sse(
            "response.completed",
            json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}),
        )
    }

    fn capacity_failed(error_type: &str, message: &str) -> String {
        sse(
            "response.failed",
            json!({
                "type":"response.failed",
                "response":{
                    "status":"failed",
                    "error":{"type":error_type,"message":message}
                }
            }),
        )
    }

    fn ok_chunks(parts: &[&str]) -> ByteStream {
        let items: Vec<Result<Bytes, std::io::Error>> = parts
            .iter()
            .map(|part| Ok(Bytes::from(part.to_string())))
            .collect();
        Box::pin(stream::iter(items))
    }

    fn chunks_then_error(parts: &[&str]) -> ByteStream {
        let mut items: Vec<Result<Bytes, std::io::Error>> = parts
            .iter()
            .map(|part| Ok(Bytes::from(part.to_string())))
            .collect();
        items.push(Err(std::io::Error::other("error decoding response body")));
        Box::pin(stream::iter(items))
    }

    fn chunks_then_named_error(parts: &[&str], message: &str) -> ByteStream {
        let mut items: Vec<Result<Bytes, std::io::Error>> = parts
            .iter()
            .map(|part| Ok(Bytes::from(part.to_string())))
            .collect();
        items.push(Err(std::io::Error::other(message.to_string())));
        Box::pin(stream::iter(items))
    }

    /// head 立即到达，tail 在 `delay` 之后到达——模拟推理模型隐藏思考的静默窗口。
    fn delayed_chunks(head: &str, delay: Duration, tail: &str) -> ByteStream {
        let head = Bytes::from(head.to_string());
        let tail = Bytes::from(tail.to_string());
        Box::pin(
            stream::once(async move { Ok::<_, std::io::Error>(head) }).chain(stream::once(
                async move {
                    tokio::time::sleep(delay).await;
                    Ok(tail)
                },
            )),
        )
    }

    fn streamed_response(parts: &[&str]) -> ProxyResponse {
        let items: Vec<Result<Bytes, std::io::Error>> = parts
            .iter()
            .map(|part| Ok(Bytes::from(part.to_string())))
            .collect();
        ProxyResponse::streamed(
            http::StatusCode::OK,
            http::HeaderMap::new(),
            stream::iter(items),
        )
    }

    #[test]
    fn native_responses_sse_error_diagnostic_is_redacted_and_classified() {
        let block = b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"type\":\"policy_violation\",\"message\":\"secret prompt text\"}}}\n\n";

        let diagnostic = native_responses_sse_error_diagnostic(block)
            .expect("response.failed should produce a diagnostic");

        assert_eq!(diagnostic.event_name, "response.failed");
        assert_eq!(diagnostic.error_type, "policy_violation");
        assert_eq!(diagnostic.message_class, "policy_or_safety");
        assert_eq!(diagnostic.message_hash.len(), 16);
        assert!(!diagnostic.message_hash.contains("secret"));
    }

    /// 每次 connect 弹出脚本队列里的下一个结果。
    fn scripted_reconnector(
        script: Vec<Result<ProxyResponse, ProxyError>>,
    ) -> (StreamReconnector, Arc<AtomicU32>) {
        scripted_reconnector_with_timeout(script, Duration::ZERO)
    }

    fn scripted_reconnector_with_timeout(
        script: Vec<Result<ProxyResponse, ProxyError>>,
        first_byte_timeout: Duration,
    ) -> (StreamReconnector, Arc<AtomicU32>) {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_clone = calls.clone();
        let script = Arc::new(Mutex::new(script));
        let reconnector = StreamReconnector::new(
            Box::new(move || {
                calls_clone.fetch_add(1, Ordering::SeqCst);
                let next = script
                    .lock()
                    .unwrap()
                    .pop()
                    .unwrap_or_else(|| Err(ProxyError::ForwardFailed("script empty".into())));
                Box::pin(async move { next })
            }),
            first_byte_timeout,
        );
        (reconnector, calls)
    }

    async fn collect(stream: impl Stream<Item = Result<Bytes, std::io::Error>>) -> String {
        futures::pin_mut!(stream);
        let mut out = String::new();
        while let Some(item) = stream.next().await {
            out.push_str(&String::from_utf8_lossy(&item.unwrap()));
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn transport_drop_before_content_retries_transparently() {
        let retry_body = [created(), text_delta("hello"), completed()].concat();
        let (reconnector, calls) =
            scripted_reconnector(vec![Ok(streamed_response(&[retry_body.as_str()]))]);
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.matches("event: message_start").count(), 1);
        assert!(out.contains("hello"));
        assert!(out.contains("event: message_stop"));
        assert!(!out.contains("event: error"), "unexpected error in: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_reconnects_after_created_before_semantic_output() {
        let retry_body = [created(), text_delta("hello"), completed()].concat();
        let (reconnector, calls) =
            scripted_reconnector(vec![Ok(streamed_response(&[retry_body.as_str()]))]);
        let first = chunks_then_error(&[created().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.matches("event: response.created").count(), 1);
        assert!(out.contains("hello"));
        assert!(out.contains("event: response.completed"));
    }

    #[tokio::test(start_paused = true)]
    async fn chat_reconnects_after_role_only_eof_before_semantic_output() {
        let retry = concat!(
            "data: {\"id\":\"chat_2\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"id\":\"chat_2\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"content\":\"recovered chat\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let (reconnector, calls) = scripted_reconnector(vec![Ok(streamed_response(&[retry]))]);
        let initial = chunks_then_error(&[
            "data: {\"id\":\"chat_1\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        ]);

        let out = collect(create_resilient_chat_sse_stream_with_context(
            initial,
            Some(reconnector),
            None,
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.matches("\"role\":\"assistant\"").count(), 1);
        assert!(out.contains("recovered chat"));
        assert!(out.contains("data: [DONE]"));
        assert!(!out.contains("ccswitch_chat_stream_"));
    }

    #[tokio::test(start_paused = true)]
    async fn chat_does_not_reconnect_after_semantic_output() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let initial = chunks_then_error(&[
            "data: {\"id\":\"chat_1\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"id\":\"chat_1\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"content\":\"already visible\"}}]}\n\n",
        ]);

        let out = collect(create_resilient_chat_sse_stream_with_context(
            initial,
            Some(reconnector),
            None,
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("already visible"));
        assert!(out.contains("ccswitch_chat_stream_interrupted"));
    }

    #[tokio::test(start_paused = true)]
    async fn chat_retry_exhaustion_emits_terminal_error() {
        let (reconnector, calls) =
            scripted_reconnector(vec![Err(ProxyError::ForwardFailed("retry failed".into()))]);
        let reconnector = reconnector.with_max_retries(1);
        let initial = chunks_then_error(&[
            "data: {\"id\":\"chat_1\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        ]);

        let out = collect(create_resilient_chat_sse_stream_with_context(
            initial,
            Some(reconnector),
            None,
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(out.contains("ccswitch_chat_stream_retries_exhausted"));
        assert!(out.contains("data: [DONE]"));
    }

    #[tokio::test(start_paused = true)]
    async fn native_capacity_failure_after_created_reconnects_when_enabled() {
        let retry_body = [created(), text_delta("recovered"), completed()].concat();
        let (reconnector, calls) =
            scripted_reconnector(vec![Ok(streamed_response(&[retry_body.as_str()]))]);
        let first = ok_chunks(&[
            created().as_str(),
            capacity_failed(
                "server_is_overloaded",
                "We're currently experiencing high demand",
            )
            .as_str(),
        ]);

        let out = collect(create_resilient_responses_sse_stream_with_context(
            first,
            Some(reconnector),
            None,
            true,
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.matches("event: response.created").count(), 1);
        assert!(out.contains("recovered"));
        assert!(
            out.matches(": ping").count() >= 50,
            "long capacity wait must keep the downstream stream alive"
        );
        assert!(!out.contains("server_is_overloaded"));
    }

    #[tokio::test(start_paused = true)]
    async fn native_capacity_failure_does_not_reconnect_after_semantic_output() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let first = ok_chunks(&[
            created().as_str(),
            text_delta("already visible").as_str(),
            capacity_failed("model_at_capacity", "Model is at capacity").as_str(),
        ]);

        let out = collect(create_resilient_responses_sse_stream_with_context(
            first,
            Some(reconnector),
            None,
            true,
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("already visible"));
        assert!(out.contains("model_at_capacity"));
    }

    #[tokio::test(start_paused = true)]
    async fn native_capacity_failure_does_not_reconnect_when_disabled() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let first = ok_chunks(&[
            created().as_str(),
            capacity_failed("overloaded_error", "Our servers are currently overloaded").as_str(),
        ]);

        let out = collect(create_resilient_responses_sse_stream_with_context(
            first,
            Some(reconnector),
            None,
            false,
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("overloaded_error"));
    }

    #[tokio::test(start_paused = true)]
    async fn chat_to_responses_capacity_failure_reconnects_before_content() {
        let retry = concat!(
            "data: {\"id\":\"chat_2\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"id\":\"chat_2\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"content\":\"recovered chat\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let (reconnector, calls) = scripted_reconnector(vec![
            Ok(streamed_response(&[retry])),
            Err(ProxyError::ForwardFailed("mock reconnect failure".into())),
        ]);
        let started_at = tokio::time::Instant::now();
        let initial = ok_chunks(&[
            "data: {\"id\":\"chat_1\",\"model\":\"qwen3.8\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "event: error\ndata: {\"error\":{\"type\":\"capacity_exceeded\",\"message\":\"Currently experiencing high demand\"}}\n\n",
        ]);
        let upstream = create_resilient_chat_sse_stream_with_context(
            initial,
            Some(reconnector.with_capacity_retry(true)),
            None,
        );
        let converted =
            super::super::streaming_codex_chat::create_responses_sse_stream_from_chat(upstream);
        let out = collect(converted).await;

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            tokio::time::Instant::now() - started_at,
            CAPACITY_RETRY_LONG_DELAY * 2,
            "Chat capacity failures must use the ten-minute tier"
        );
        assert_eq!(out.matches("event: response.created").count(), 1);
        assert!(out.contains("recovered chat"));
        assert!(!out.contains("capacity_exceeded"));
    }

    #[tokio::test(start_paused = true)]
    async fn anthropic_to_responses_capacity_failure_reconnects_after_message_start() {
        let retry = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_2\",\"model\":\"claude\"}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"recovered anthropic\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        );
        let (reconnector, calls) = scripted_reconnector(vec![Ok(streamed_response(&[retry]))]);
        let initial = ok_chunks(&[
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude\"}}\n\n",
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Our servers are currently overloaded\"}}\n\n",
        ]);
        let upstream =
            create_resilient_anthropic_upstream_sse_stream(initial, Some(reconnector), true, None);
        let converted =
            super::super::streaming_codex_anthropic::create_responses_sse_stream_from_anthropic(
                upstream,
            );
        let out = collect(converted).await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.matches("event: response.created").count(), 1);
        assert!(out.contains("recovered anthropic"));
        assert!(!out.contains("overloaded_error"));
    }

    #[tokio::test(start_paused = true)]
    async fn anthropic_to_responses_transport_drop_retries_after_reconnect_failure() {
        let retry = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_3\",\"model\":\"claude\"}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"recovered after reconnect failure\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        );
        let (reconnector, calls) = scripted_reconnector(vec![
            Ok(streamed_response(&[retry])),
            Err(ProxyError::ForwardFailed("first reconnect failed".into())),
        ]);
        let reconnector = reconnector.with_max_retries(2);
        let initial = chunks_then_error(&[
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude\"}}\n\n",
        ]);
        let upstream =
            create_resilient_anthropic_upstream_sse_stream(initial, Some(reconnector), true, None);
        let converted =
            super::super::streaming_codex_anthropic::create_responses_sse_stream_from_anthropic(
                upstream,
            );
        let out = collect(converted).await;

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(out.matches("event: response.created").count(), 1);
        assert!(out.contains("recovered after reconnect failure"));
        assert!(
            !out.contains("stream_error"),
            "unexpected terminal error: {out}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn chat_capacity_failure_after_text_is_not_replayed() {
        let input = concat!(
            "data: {\"id\":\"chat_1\",\"choices\":[{\"delta\":{\"content\":\"visible\"}}]}\n\n",
            "event: error\ndata: {\"error\":{\"type\":\"model_at_capacity\",\"message\":\"Model is at capacity\"}}\n\n"
        );
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let upstream = create_resilient_chat_sse_stream_with_context(
            ok_chunks(&[input]),
            Some(reconnector.with_capacity_retry(true)),
            None,
        );
        let converted =
            super::super::streaming_codex_chat::create_responses_sse_stream_from_chat(upstream);
        let out = collect(converted).await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("visible"));
        assert!(out.contains("model_at_capacity"));
        assert!(out.contains("event: response.failed"));
        assert!(!out.contains("event: response.completed"));
    }

    #[tokio::test(start_paused = true)]
    async fn anthropic_capacity_failure_after_text_is_not_replayed() {
        let input = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude\"}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"visible\"}}\n\n",
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"overloaded\"}}\n\n"
        );
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let upstream = create_resilient_anthropic_upstream_sse_stream(
            ok_chunks(&[input]),
            Some(reconnector),
            true,
            None,
        );
        let converted =
            super::super::streaming_codex_anthropic::create_responses_sse_stream_from_anthropic(
                upstream,
            );
        let out = collect(converted).await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("visible"));
        assert!(out.contains("overloaded_error"));
        assert!(out.contains("event: response.failed"));
        assert!(!out.contains("event: response.completed"));
    }

    #[test]
    fn capacity_classifier_rejects_quota_auth_and_bare_retry_later() {
        for payload in [
            json!({"error":{"type":"insufficient_quota","message":"quota exhausted"}}),
            json!({"error":{"type":"authentication_error","message":"invalid token"}}),
            json!({"error":{"type":"invalid_request_error","message":"Please try again later"}}),
        ] {
            assert!(!is_capacity_error_payload(&payload, None), "{payload}");
        }
        assert!(is_capacity_error_payload(
            &json!({"error":{"type":"server_error","message":"Please try again later"}}),
            Some(http::StatusCode::SERVICE_UNAVAILABLE),
        ));
    }

    #[test]
    fn capacity_classifier_accepts_explicit_concurrency_pressure_and_marks_long_wait() {
        for message in [
            "concurrent limit reached",
            "Concurrency limit reached for this model",
            "Too many concurrent requests",
            "We're currently experiencing high demand",
        ] {
            let payload = json!({"error":{"type":"server_error","message":message}});
            assert!(is_capacity_error_payload(&payload, None), "{message}");
            assert!(
                capacity_error_requires_long_wait(&payload),
                "expected long-wait marker for {message}"
            );
        }

        let ordinary =
            json!({"error":{"type":"server_is_overloaded","message":"Please try again later"}});
        assert!(is_capacity_error_payload(&ordinary, None));
        assert!(!capacity_error_requires_long_wait(&ordinary));
        assert!(!capacity_error_body_requires_long_wait(Some(
            r#"{"error":{"type":"insufficient_quota","message":"quota exhausted"}}"#
        )));
    }

    #[test]
    fn capacity_classifier_accepts_bodyless_server_load_statuses() {
        for status in [
            http::StatusCode::BAD_GATEWAY,
            http::StatusCode::SERVICE_UNAVAILABLE,
            http::StatusCode::GATEWAY_TIMEOUT,
        ] {
            assert!(is_capacity_error_response(status, None), "status={status}");
        }
        assert!(!is_capacity_error_response(
            http::StatusCode::TOO_MANY_REQUESTS,
            None,
        ));
        for body in [
            r#"{"error":{"type":"insufficient_quota","message":"quota exhausted"}}"#,
            r#"{"error":{"type":"authentication_error","message":"invalid token"}}"#,
            r#"{"error":{"type":"invalid_request_error","message":"unsupported parameter"}}"#,
            r#"{"error":{"type":"policy_violation","message":"request blocked"}}"#,
        ] {
            assert!(!is_capacity_error_response(
                http::StatusCode::SERVICE_UNAVAILABLE,
                Some(body),
            ));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_clean_eof_before_content_recovers() {
        let retry_body = [created(), text_delta("recovered"), completed()].concat();
        let (reconnector, calls) =
            scripted_reconnector(vec![Ok(streamed_response(&[&retry_body]))]);
        let out = collect(create_resilient_responses_sse_stream(
            ok_chunks(&[&created()]),
            Some(reconnector),
        ))
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(out.matches("event: response.created").count(), 1);
        assert!(out.contains("recovered"));
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_transport_retry_budget_is_bounded() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let out = collect(create_resilient_responses_sse_stream(
            chunks_then_error(&[&created()]),
            Some(reconnector),
        ))
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        assert!(out.contains("自动重连已耗尽"));
        assert!(!out.contains("event: response.completed"));
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_failed_terminal_is_preserved_byte_for_byte() {
        let failure = sse(
            "response.failed",
            json!({"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"try again later"}}}),
        );
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let out = collect(create_resilient_responses_sse_stream(
            ok_chunks(&[&failure]),
            Some(reconnector),
        ))
        .await;
        assert_eq!(out, failure);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_never_reconnects_after_output_item_done() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let item_done = sse(
            "response.output_item.done",
            json!({"type":"response.output_item.done","item":{"type":"function_call","name":"write_file"}}),
        );
        let first = ok_chunks(&[[created(), item_done].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "must not replay a completed item"
        );
        assert!(out.contains("response.output_item.done"));
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_surfaces_post_content_chunked_eof_as_protocol_error() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let first = chunks_then_named_error(
            &[[created(), text_delta("partial")].concat().as_str()],
            "error decoding response body: unexpected EOF during chunk size line",
        );

        let items: Vec<_> = create_resilient_responses_sse_stream(first, Some(reconnector))
            .collect()
            .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not replay output");
        assert!(
            items.iter().all(Result::is_ok),
            "the downstream HTTP body must close cleanly: {items:?}"
        );
        let out = items
            .into_iter()
            .map(Result::unwrap)
            .fold(String::new(), |mut output, bytes| {
                output.push_str(&String::from_utf8_lossy(&bytes));
                output
            });
        assert!(out.contains("event: response.failed"), "got: {out}");
        assert!(out.contains("上游响应流连接提前关闭"), "got: {out}");
        assert!(out.contains("HTTP 分块响应未完整结束"), "got: {out}");
        assert!(!out.contains("error decoding response body"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_semantic_output_eof_is_error_without_retry() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let first = ok_chunks(&[[created(), text_delta("partial")].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not replay output");
        assert!(out.contains("event: response.failed"), "got: {out}");
        assert!(out.contains("terminal event"), "got: {out}");
        assert!(!out.contains("event: response.completed"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_without_reconnector_still_rejects_missing_terminal() {
        let first = ok_chunks(&[[created(), text_delta("partial")].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(first, None)).await;

        assert!(out.contains("event: response.failed"), "got: {out}");
        assert!(out.contains("terminal event"), "got: {out}");
        assert!(!out.contains("event: response.completed"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_completed_with_failed_status_is_error() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let invalid_terminal = sse(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "status": "failed",
                    "output": [{
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "not complete"}]
                    }]
                }
            }),
        );
        let first = ok_chunks(&[[created(), invalid_terminal].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("event: response.failed"), "got: {out}");
        assert!(out.contains("status=failed"), "got: {out}");
        assert!(!out.contains("event: response.completed"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_completed_with_incomplete_status_is_error() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let invalid_terminal = sse(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "status": "incomplete",
                    "output": [{
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "cut off"}]
                    }]
                }
            }),
        );
        let first = ok_chunks(&[[created(), invalid_terminal].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("event: response.failed"), "got: {out}");
        assert!(out.contains("status=incomplete"), "got: {out}");
        assert!(!out.contains("event: response.completed"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_reasoning_only_completed_is_error() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let reasoning = sse(
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "reasoning",
                    "content": [{"type": "reasoning_text", "text": "Need another tool."}]
                }
            }),
        );
        let invalid_terminal = sse(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": [{
                        "type": "reasoning",
                        "content": [{"type": "reasoning_text", "text": "Need another tool."}]
                    }]
                }
            }),
        );
        let first = ok_chunks(&[[created(), reasoning, invalid_terminal].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("event: response.failed"), "got: {out}");
        assert!(out.contains("final output"), "got: {out}");
        assert!(!out.contains("event: response.completed"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_completed_with_valid_tool_call_is_forwarded() {
        let tool = json!({
            "type": "function_call",
            "status": "completed",
            "call_id": "call_1",
            "name": "read_file",
            "arguments": "{\"path\":\"README.md\"}"
        });
        let item_done = sse(
            "response.output_item.done",
            json!({"type": "response.output_item.done", "item": tool.clone()}),
        );
        let terminal = sse(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {"status": "completed", "output": [tool]}
            }),
        );
        let first = ok_chunks(&[[created(), item_done, terminal].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(first, None)).await;

        assert!(out.contains("event: response.completed"), "got: {out}");
        assert!(!out.contains("event: error"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_completed_with_compaction_output_is_forwarded() {
        let compaction = json!({
            "type": "compaction",
            "encrypted_content": "ocx1:YWJj"
        });
        let item_done = sse(
            "response.output_item.done",
            json!({"type": "response.output_item.done", "item": compaction.clone()}),
        );
        let terminal = sse(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {"status": "completed", "output": [compaction]}
            }),
        );
        let first = ok_chunks(&[[created(), item_done, terminal].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(first, None)).await;

        assert!(out.contains("event: response.completed"), "got: {out}");
        assert!(!out.contains("event: error"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_completed_with_incomplete_tool_call_is_error() {
        let terminal = sse(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": [{
                        "type": "function_call",
                        "status": "completed",
                        "call_id": "call_1",
                        "name": "",
                        "arguments": "{}"
                    }]
                }
            }),
        );
        let first = ok_chunks(&[[created(), terminal].concat().as_str()]);

        let out = collect(create_resilient_responses_sse_stream(first, None)).await;

        assert!(out.contains("event: response.failed"), "got: {out}");
        assert!(out.contains("structurally incomplete"), "got: {out}");
        assert!(!out.contains("event: response.completed"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_terminal_incomplete_stops_following_events() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let incomplete = sse(
            "response.incomplete",
            json!({
                "type": "response.incomplete",
                "response": {
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"}
                }
            }),
        );
        let first = ok_chunks(&[[created(), incomplete, text_delta("must-not-leak")]
            .concat()
            .as_str()]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(out.contains("event: response.incomplete"), "got: {out}");
        assert!(!out.contains("must-not-leak"), "got: {out}");
        assert!(!out.contains("event: error"), "got: {out}");
    }

    #[test]
    fn native_responses_transport_error_message_distinguishes_true_timeout() {
        let timeout = std::io::Error::new(std::io::ErrorKind::TimedOut, "operation timed out");

        assert_eq!(
            native_responses_transport_error_message(&timeout),
            "上游响应流读取超时，请检查网络或代理后重试"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn native_responses_reconnects_after_comment_keepalive() {
        let retry_body = [created(), text_delta("recovered"), completed()].concat();
        let (reconnector, calls) =
            scripted_reconnector(vec![Ok(streamed_response(&[retry_body.as_str()]))]);
        let first = chunks_then_error(&[created().as_str(), ": upstream-ping\n\n"]);

        let out = collect(create_resilient_responses_sse_stream(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(out.contains("recovered"));
    }

    #[tokio::test(start_paused = true)]
    async fn premature_eof_without_terminal_event_retries() {
        let retry_body = [created(), text_delta("ok"), completed()].concat();
        let (reconnector, calls) =
            scripted_reconnector(vec![Ok(streamed_response(&[retry_body.as_str()]))]);
        // 干净 EOF：无传输错误，也没有任何终止事件（Codex CLI 同样视为可重试）。
        let first = ok_chunks(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(out.contains("event: message_stop"));
        assert!(!out.contains("event: error"), "unexpected error in: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn no_retry_after_content_reached_client() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let first = chunks_then_error(&[[created(), text_delta("partial")].concat().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not reconnect");
        assert!(out.contains("partial"));
        assert!(out.contains("\"type\":\"stream_error\""));
    }

    #[tokio::test(start_paused = true)]
    async fn upstream_semantic_failure_is_not_retried() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let failed = sse(
            "response.failed",
            json!({"type":"response.failed","response":{"status":"failed","error":{"type":"server_error","message":"backend exploded"}}}),
        );
        let first = ok_chunks(&[[created(), failed].concat().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not reconnect");
        assert!(out.contains("backend exploded"));
    }

    #[tokio::test(start_paused = true)]
    async fn spoofed_stream_error_type_from_upstream_is_not_retried() {
        let (reconnector, calls) = scripted_reconnector(vec![]);
        // 上游语义性 error 事件的 error.type 逐字透传；恰好叫 "stream_error"
        // 也不能触发重试——只有转换器附加了 marker 注释行的中断才可重试。
        let spoofed = sse(
            "error",
            json!({"type":"error","error":{"type":"stream_error","message":"upstream says no"}}),
        );
        let first = ok_chunks(&[[created(), spoofed].concat().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not reconnect");
        assert!(out.contains("upstream says no"), "got: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn exhausts_bounded_retries_then_surfaces_error() {
        // 每次重连都成功建立、随即掐断：耗尽全部 5 次后必须把错误交给客户端。
        let script: Vec<Result<ProxyResponse, ProxyError>> = (0..5)
            .map(|_| {
                Ok(ProxyResponse::streamed(
                    http::StatusCode::OK,
                    http::HeaderMap::new(),
                    stream::iter(vec![
                        Ok(Bytes::from(created())),
                        Err(std::io::Error::other("connection reset")),
                    ]),
                ))
            })
            .collect();
        let (reconnector, calls) = scripted_reconnector(script);
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 5);
        assert!(out.contains("after 5 reconnect attempt(s)"), "got: {out}");
        assert_eq!(out.matches("event: message_start").count(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_failure_counts_as_attempt() {
        let retry_body = [created(), text_delta("ok"), completed()].concat();
        // 脚本按 pop() 逆序消费：两次失败后第三次成功。
        let (reconnector, calls) = scripted_reconnector(vec![
            Ok(streamed_response(&[retry_body.as_str()])),
            Err(ProxyError::ForwardFailed("connect refused".into())),
            Err(ProxyError::ForwardFailed("connect refused".into())),
        ]);
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(out.contains("event: message_stop"));
        assert!(!out.contains("event: error"), "unexpected error in: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn non_success_reconnect_status_counts_as_attempt() {
        let retry_body = [created(), text_delta("ok"), completed()].concat();
        let (reconnector, calls) = scripted_reconnector(vec![
            Ok(streamed_response(&[retry_body.as_str()])),
            Ok(ProxyResponse::buffered(
                http::StatusCode::BAD_GATEWAY,
                http::HeaderMap::new(),
                Bytes::new(),
            )),
        ]);
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(out.contains("event: message_stop"));
    }

    #[tokio::test(start_paused = true)]
    async fn keepalive_ping_emitted_during_retry_when_message_start_sent() {
        let retry_body = [created(), text_delta("ok"), completed()].concat();
        let (reconnector, _calls) =
            scripted_reconnector(vec![Ok(streamed_response(&[retry_body.as_str()]))]);
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert!(
            out.contains("event: ping"),
            "expected keepalive ping: {out}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keepalive_pings_flow_during_slow_reconnect() {
        // connect 挂 25 秒才成功：期间必须周期性发 ping，否则下游 passthrough
        // 的 120s 空闲超时会在真实场景中掐掉这次合法的重试。
        let retry_body = [created(), text_delta("ok"), completed()].concat();
        let calls = Arc::new(AtomicU32::new(0));
        let calls_clone = calls.clone();
        let body = Arc::new(Mutex::new(Some(retry_body)));
        let reconnector = StreamReconnector::new(
            Box::new(move || {
                calls_clone.fetch_add(1, Ordering::SeqCst);
                let body = body.lock().unwrap().take().expect("single reconnect");
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_secs(25)).await;
                    Ok(streamed_response(&[body.as_str()]))
                })
            }),
            Duration::ZERO,
        );
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(out.contains("event: message_stop"));
        // 重连前 1 次 + 25 秒连接期间（10s/20s 处）至少 2 次。
        assert!(
            out.matches("event: ping").count() >= 3,
            "expected keepalive pings during slow reconnect: {out}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn keepalive_pings_flow_while_awaiting_first_reconnected_event() {
        // 重连秒回，但新流 30 秒后才产出首个事件；等待期间同样要发 ping。
        let retry_body = [created(), text_delta("ok"), completed()].concat();
        let delayed = ProxyResponse::streamed(
            http::StatusCode::OK,
            http::HeaderMap::new(),
            stream::once(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(Bytes::from(retry_body))
            }),
        );
        let (reconnector, calls) =
            scripted_reconnector_with_timeout(vec![Ok(delayed)], Duration::from_secs(60));
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(out.contains("event: message_stop"));
        assert!(
            out.matches("event: ping").count() >= 3,
            "expected keepalive pings while awaiting first event: {out}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn thinking_silence_emits_keepalive_pings_without_retry() {
        // message_start 之后上游静默 60 秒（推理模型隐藏思考）：期间必须周期性
        // 发 ping 喂下游空闲计时器，且不得触发重连——静默不是中断。
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let tail = [text_delta("ok"), completed()].concat();
        let first = delayed_chunks(&created(), Duration::from_secs(60), &tail);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not reconnect");
        assert!(out.contains("event: message_stop"));
        assert!(!out.contains("event: error"), "unexpected error in: {out}");
        let pings = out.matches("event: ping").count();
        assert!(
            pings >= 4,
            "expected keepalive pings during thinking silence, got {pings}: {out}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn thinking_silence_keepalive_stops_at_limit() {
        // 上游静默远超上限：心跳只覆盖前 300 秒，之后停发，
        // 把死流的裁决权交还给外层空闲超时。
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let tail = [text_delta("ok"), completed()].concat();
        let silence = UPSTREAM_SILENCE_KEEPALIVE_LIMIT + Duration::from_secs(100);
        let first = delayed_chunks(&created(), silence, &tail);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not reconnect");
        assert!(out.contains("event: message_stop"));
        let pings = out.matches("event: ping").count();
        let cap =
            (UPSTREAM_SILENCE_KEEPALIVE_LIMIT.as_secs() / KEEPALIVE_INTERVAL.as_secs()) as usize;
        assert!(pings <= cap, "pings must stop at the limit, got {pings}");
        assert!(
            pings >= cap - 2,
            "expected pings up to the limit, got {pings} (cap {cap})"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn no_keepalive_before_message_start() {
        // message_start 之前（上游还没发 response.created）不发 ping：该阶段由
        // 首包超时语义治理，提前 ping 会向客户端伪造"响应已开始"。
        let (reconnector, calls) = scripted_reconnector(vec![]);
        let body = [created(), text_delta("ok"), completed()].concat();
        let first: ByteStream = Box::pin(stream::once(async move {
            tokio::time::sleep(Duration::from_secs(45)).await;
            Ok::<_, std::io::Error>(Bytes::from(body))
        }));
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0, "must not reconnect");
        assert!(
            !out.contains("event: ping"),
            "no pings before message_start: {out}"
        );
        assert!(out.contains("event: message_stop"));
    }

    #[tokio::test(start_paused = true)]
    async fn thinking_silence_pings_flow_without_reconnector() {
        // 心跳不依赖重连工厂：reconnector 为 None 的路径同样要保活思考期。
        let tail = [text_delta("ok"), completed()].concat();
        let first = delayed_chunks(&created(), Duration::from_secs(60), &tail);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first, None,
        ))
        .await;

        assert!(out.contains("event: message_stop"));
        assert!(!out.contains("event: error"), "unexpected error in: {out}");
        let pings = out.matches("event: ping").count();
        assert!(
            pings >= 4,
            "expected keepalive pings during thinking silence, got {pings}: {out}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn silent_reconnected_stream_times_out_and_retries_again() {
        // 重连成功但新流静默挂起：首包超时后计入尝试次数并再次重连。
        let retry_body = [created(), text_delta("ok"), completed()].concat();
        let hanging = ProxyResponse::streamed(
            http::StatusCode::OK,
            http::HeaderMap::new(),
            stream::pending::<Result<Bytes, std::io::Error>>(),
        );
        // pop() 逆序消费：先挂起流，再成功流。
        let (reconnector, calls) = scripted_reconnector_with_timeout(
            vec![Ok(streamed_response(&[retry_body.as_str()])), Ok(hanging)],
            Duration::from_secs(5),
        );
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first,
            Some(reconnector),
        ))
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(out.contains("event: message_stop"));
        assert!(!out.contains("event: error"), "unexpected error in: {out}");
    }

    #[tokio::test(start_paused = true)]
    async fn passthrough_without_reconnector_preserves_current_behavior() {
        let first = chunks_then_error(&[created().as_str()]);
        let out = collect(create_resilient_anthropic_sse_stream_from_responses(
            first, None,
        ))
        .await;

        assert!(out.contains("\"type\":\"stream_error\""));
    }
}
