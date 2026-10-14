//! Bounded multimodel orchestration runtime.
//!
//! Profiles are deliberately implemented above the normal provider forwarding
//! stack. Every internal call still uses `RequestContext`, the configured
//! provider adapter, auth injection, retries, and response decoding. The
//! runtime only owns the small planner -> worker -> verifier loop and the
//! protocol-shaped response returned to the client.

use super::{
    handler_context::RequestContext, response_processor::read_decoded_body, server::ProxyState,
    ProxyError,
};
use crate::{
    app_config::AppType,
    orchestration::{Event, ModelApp, ModelRef, Profile, Route, Run, Settings},
    proxy::forwarder::ClientRequestBodyBytes,
    proxy::providers::openai_compat,
};
use axum::{
    body::Body,
    http::{header, Extensions, HeaderMap, Method, StatusCode},
    response::Response,
};
use bytes::Bytes;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Mutex, time::Duration};

static CANCELLATION_REQUESTS: Lazy<Mutex<HashSet<String>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

/// Mark an in-flight orchestration for cancellation.
pub(crate) fn request_cancel(run_id: &str) -> bool {
    CANCELLATION_REQUESTS
        .lock()
        .map(|mut runs| runs.insert(run_id.to_string()))
        .unwrap_or(false)
}

pub(crate) fn is_cancelled(run_id: &str) -> bool {
    CANCELLATION_REQUESTS
        .lock()
        .map(|runs| runs.contains(run_id))
        .unwrap_or(false)
}

pub(crate) fn provider_for_role(
    state: &ProxyState,
    role: &ModelRef,
) -> Result<crate::provider::Provider, ProxyError> {
    let provider = state
        .db
        .get_provider_by_id(&role.provider_id, role.app_type.as_str())
        .map_err(|error| ProxyError::DatabaseError(error.to_string()))?
        .ok_or_else(|| {
            ProxyError::ConfigError(format!(
                "Orchestration provider '{}' was not found for {}",
                role.provider_id,
                role.app_type.as_str()
            ))
        })?;
    crate::orchestration::validate_role_provider(role, &provider)
        .map_err(ProxyError::ConfigError)?;
    Ok(provider)
}

fn clear_cancel(run_id: &str) {
    if let Ok(mut runs) = CANCELLATION_REQUESTS.lock() {
        runs.remove(run_id);
    }
}

/// Resolve a request once. This is shared by the handlers so a profile alias
/// can run the engine while a role alias can be rewritten to its real model
/// before the normal direct handler continues.
pub(crate) fn resolve_route(
    settings: &Settings,
    app_type: &str,
    model: &str,
) -> Result<Option<Route>, ProxyError> {
    // Claude Desktop has its own app identifier in the provider store, but it
    // speaks the same Messages protocol as Claude Code/API clients.
    let route_app_type = if app_type == "claude-desktop" {
        "claude"
    } else {
        app_type
    };
    settings
        .resolve(route_app_type, model)
        .map_err(ProxyError::ConfigError)
}

#[derive(Clone, Copy)]
pub(crate) struct ClientRequest<'a> {
    pub body: &'a Value,
    pub headers: &'a HeaderMap,
    pub app: &'a AppType,
    pub app_type: &'static str,
    pub endpoint: &'a str,
    pub is_stream: bool,
}

pub(crate) async fn run_profile(
    state: &ProxyState,
    profile: Profile,
    request: ClientRequest<'_>,
) -> Result<Response, ProxyError> {
    let ClientRequest {
        body: original_body,
        headers,
        app: outer_app,
        app_type: outer_app_type,
        endpoint,
        is_stream,
    } = request;
    let run_id = format!("orch-{}", uuid::Uuid::new_v4());
    let session_id =
        crate::proxy::extract_session_id(headers, original_body, outer_app_type).session_id;
    let mut run = Run {
        id: run_id.clone(),
        profile_id: profile.id.clone(),
        app_type: outer_app_type.to_string(),
        session_id,
        status: "running".to_string(),
        started_at: chrono::Utc::now().timestamp(),
        finished_at: None,
        events: Vec::new(),
    };
    persist_run(state, &mut run)?;

    let outer_protocol = protocol_for_app(outer_app).ok_or_else(|| {
        ProxyError::ConfigError(format!(
            "Orchestration is not supported for {}",
            outer_app_type
        ))
    })?;
    let has_tools = request_has_tools(original_body);
    let same_protocol_worker = profile.worker.app_type == outer_protocol;
    if has_tools && !same_protocol_worker {
        record_stage(state, &mut run, "tool_request_fallback", Some("worker"))?;
        let fallback = bounded_fallback(
            state,
            &profile,
            request,
            "Tool-bearing orchestration requests require the worker and client to use the same protocol",
        )
        .await;
        run.status = if fallback.is_ok() {
            "fallback".to_string()
        } else {
            "failed".to_string()
        };
        run.finished_at = Some(chrono::Utc::now().timestamp());
        persist_run(state, &mut run)?;
        clear_cancel(&run_id);
        return fallback;
    }

    let result = tokio::time::timeout(
        Duration::from_secs(profile.budget.timeout_seconds),
        execute_profile(
            state,
            &profile,
            original_body,
            headers,
            outer_protocol,
            &run_id,
            &mut run,
        ),
    )
    .await;

    let response = match result {
        Ok(Ok(answer)) => {
            run.status = if matches!(answer, ProfileAnswer::ToolCall(_)) {
                "tool_pending".to_string()
            } else if run.status == "fallback" {
                "fallback".to_string()
            } else {
                "verified".to_string()
            };
            Some(match answer {
                ProfileAnswer::Text(answer) => build_client_response(
                    outer_app,
                    endpoint,
                    is_stream,
                    original_body
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or(&profile.picker_model()),
                    &answer,
                )?,
                ProfileAnswer::ToolCall(value) => build_client_tool_response(
                    outer_app,
                    endpoint,
                    is_stream,
                    original_body
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or(&profile.picker_model()),
                    value,
                )?,
            })
        }
        Ok(Err(error)) => {
            if is_cancelled(&run_id) {
                run.status = "cancelled".to_string();
                None
            } else {
                let fallback = bounded_fallback(state, &profile, request, &error.to_string()).await;
                run.status = if fallback.is_ok() {
                    "fallback".to_string()
                } else {
                    "failed".to_string()
                };
                run.finished_at = Some(chrono::Utc::now().timestamp());
                persist_run(state, &mut run)?;
                clear_cancel(&run_id);
                return fallback;
            }
        }
        Err(_) => {
            let fallback = bounded_fallback(
                state,
                &profile,
                request,
                "Orchestration timed out before the bounded budget completed",
            )
            .await;
            run.status = if fallback.is_ok() {
                "fallback".to_string()
            } else {
                "failed".to_string()
            };
            run.finished_at = Some(chrono::Utc::now().timestamp());
            persist_run(state, &mut run)?;
            clear_cancel(&run_id);
            return fallback;
        }
    };

    run.finished_at = Some(chrono::Utc::now().timestamp());
    persist_run(state, &mut run)?;
    clear_cancel(&run_id);
    response.ok_or_else(|| ProxyError::InvalidRequest("Orchestration cancelled".to_string()))
}

async fn execute_profile(
    state: &ProxyState,
    profile: &Profile,
    original_body: &Value,
    headers: &HeaderMap,
    outer_protocol: ModelApp,
    run_id: &str,
    run: &mut Run,
) -> Result<ProfileAnswer, ProxyError> {
    check_cancelled(run_id)?;
    let task = extract_task_text(original_body);
    if task.is_empty() {
        return Err(ProxyError::InvalidRequest(
            "Orchestration requires a textual user request".to_string(),
        ));
    }

    record_stage(state, run, "planner_started", Some("orchestrator"))?;
    let planner_prompt = format!(
        "You are the orchestration mastermind. Analyze the user's task below and produce a \
         concise, actionable work plan for another model. Include: objective, ordered steps, \
         acceptance criteria, risks, and what must be verified. Do not claim that work was \
         completed.\n\nUser task:\n{task}"
    );
    let plan = call_role(
        state,
        &profile.orchestrator,
        &planner_prompt,
        headers,
        profile.budget.max_output_tokens,
    )
    .await?;
    record_stage(state, run, "planner_completed", Some("orchestrator"))?;

    let mut answer = String::new();
    let mut verifier_feedback = String::new();
    for (worker_calls, round) in (0..profile.budget.max_rounds).enumerate() {
        check_cancelled(run_id)?;
        if worker_calls as u32 >= profile.budget.max_worker_calls {
            break;
        }
        record_stage(
            state,
            run,
            &format!("worker_started_round_{}", round + 1),
            Some("worker"),
        )?;
        let worker_prompt = format!(
            "You are the execution model. Complete the user's task using the orchestrator's \
             plan. Return the best final answer or patch-ready result, be explicit about \
             limitations, and do not invent verification.\n\nUser task:\n{task}\n\n\
             Orchestrator plan:\n{plan}\n\nWorker guidance:\n{}\n\nVerifier feedback from \
             the previous round:\n{}",
            profile.worker_guidance,
            if verifier_feedback.is_empty() {
                "none"
            } else {
                &verifier_feedback
            }
        );
        if request_has_tools(original_body) {
            let worker_body = worker_request_body(
                profile,
                original_body,
                &worker_prompt,
                profile.budget.max_output_tokens,
                outer_protocol,
            )?;
            let worker_value =
                call_role_value(state, &profile.worker, worker_body, headers).await?;
            if has_tool_calls(profile.worker.app_type, &worker_value) {
                record_stage(
                    state,
                    run,
                    &format!("worker_tool_call_round_{}", round + 1),
                    Some("worker"),
                )?;
                return Ok(ProfileAnswer::ToolCall(normalize_worker_value(
                    original_body,
                    worker_value,
                )));
            }
            answer =
                extract_response_text(profile.worker.app_type, &worker_value).ok_or_else(|| {
                    ProxyError::TransformError(
                        "Orchestration worker returned no textual answer".to_string(),
                    )
                })?;
        } else {
            answer = call_role(
                state,
                &profile.worker,
                &worker_prompt,
                headers,
                profile.budget.max_output_tokens,
            )
            .await?;
        }
        record_stage(
            state,
            run,
            &format!("worker_completed_round_{}", round + 1),
            Some("worker"),
        )?;

        let Some(verifier) = &profile.verifier else {
            return Ok(ProfileAnswer::Text(answer));
        };
        check_cancelled(run_id)?;
        record_stage(state, run, "verifier_started", Some("verifier"))?;
        let verifier_prompt = format!(
            "Review the execution result against the user task and plan. Start your response \
             with exactly PASS if it is acceptable; otherwise start with FAIL and give concrete \
             corrections for the next worker round.\n\nTask:\n{task}\n\nPlan:\n{plan}\n\n\
             Execution result:\n{answer}"
        );
        let verdict = call_role(
            state,
            verifier,
            &verifier_prompt,
            headers,
            profile.budget.max_output_tokens,
        )
        .await?;
        record_stage(state, run, "verifier_completed", Some("verifier"))?;
        if verifier_accepts(&verdict) {
            return Ok(ProfileAnswer::Text(answer));
        }
        verifier_feedback = verdict;
    }

    if answer.is_empty() {
        Err(ProxyError::InvalidRequest(
            "Orchestration exhausted its worker budget without a result".to_string(),
        ))
    } else {
        Err(ProxyError::InvalidRequest(
            "Verifier did not approve the bounded worker result".to_string(),
        ))
    }
}

#[derive(Debug)]
enum ProfileAnswer {
    Text(String),
    ToolCall(Value),
}

async fn fail_or_direct_fallback(
    state: &ProxyState,
    profile: &Profile,
    request: ClientRequest<'_>,
    reason: &str,
) -> Result<Response, ProxyError> {
    let ClientRequest {
        body: original_body,
        headers,
        app: outer_app,
        endpoint,
        is_stream,
        ..
    } = request;
    if profile.failure_fallback != "direct" {
        return Err(ProxyError::InvalidRequest(format!(
            "Orchestration failed: {reason}"
        )));
    }
    let task = extract_task_text(original_body);
    let prompt = format!(
        "Complete this user task directly. The orchestration layer could not safely finish \
         ({reason}). Give the best truthful result and state any uncertainty.\n\n{task}"
    );
    let answer = call_role(
        state,
        &profile.worker,
        &prompt,
        headers,
        profile.budget.max_output_tokens,
    )
    .await?;
    build_client_response(
        outer_app,
        endpoint,
        is_stream,
        original_body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(&profile.worker.model),
        &answer,
    )
}

async fn bounded_fallback(
    state: &ProxyState,
    profile: &Profile,
    request: ClientRequest<'_>,
    reason: &str,
) -> Result<Response, ProxyError> {
    tokio::time::timeout(
        Duration::from_secs(profile.budget.timeout_seconds),
        fail_or_direct_fallback(state, profile, request, reason),
    )
    .await
    .map_err(|_| {
        ProxyError::InvalidRequest(
            "Direct fallback timed out before the profile budget completed".to_string(),
        )
    })?
}

fn persist_run(state: &ProxyState, run: &mut Run) -> Result<(), ProxyError> {
    state
        .db
        .save_orchestration_run(run)
        .map_err(|error| ProxyError::DatabaseError(error.to_string()))
}

fn record_stage(
    state: &ProxyState,
    run: &mut Run,
    stage: &str,
    role: Option<&str>,
) -> Result<(), ProxyError> {
    run.events.push(Event {
        stage: stage.to_string(),
        at: chrono::Utc::now().timestamp(),
        role: role.map(str::to_string),
        input_tokens: None,
        output_tokens: None,
    });
    persist_run(state, run)
}

fn check_cancelled(run_id: &str) -> Result<(), ProxyError> {
    if is_cancelled(run_id) {
        Err(ProxyError::InvalidRequest(
            "Orchestration cancelled by the client".to_string(),
        ))
    } else {
        Ok(())
    }
}

async fn call_role(
    state: &ProxyState,
    role: &ModelRef,
    prompt: &str,
    original_headers: &HeaderMap,
    max_output_tokens: u64,
) -> Result<String, ProxyError> {
    let body = role_request_body(role, prompt, max_output_tokens);
    let value = call_role_value(state, role, body, original_headers).await?;
    extract_response_text(role.app_type, &value).ok_or_else(|| {
        ProxyError::TransformError("Orchestration model returned no textual answer".to_string())
    })
}

async fn call_role_value(
    state: &ProxyState,
    role: &ModelRef,
    body: Value,
    original_headers: &HeaderMap,
) -> Result<Value, ProxyError> {
    let provider = provider_for_role(state, role)?;

    let mut headers = original_headers.clone();
    for name in [
        header::AUTHORIZATION,
        header::HeaderName::from_static("x-api-key"),
        header::HeaderName::from_static("x-goog-api-key"),
        header::CONTENT_LENGTH,
        header::CONTENT_ENCODING,
        header::HeaderName::from_static("accept-encoding"),
    ] {
        headers.remove(name);
    }

    let app_type = role.app_type.app_type();
    let endpoint = match role.app_type {
        ModelApp::Claude => "/v1/messages",
        ModelApp::Codex => "/v1/responses",
    };
    let mut ctx = RequestContext::new_with_provider(
        state,
        &body,
        &headers,
        app_type.clone(),
        "Orchestration",
        role.app_type.as_str(),
        provider,
    )
    .await?;
    let mut extensions = Extensions::new();
    let body_len = serde_json::to_vec(&body)
        .map_err(|error| ProxyError::Internal(error.to_string()))?
        .len();
    extensions.insert(ClientRequestBodyBytes(body_len));
    let forwarder = ctx.create_forwarder(state);
    let mut result = forwarder
        .forward_with_retry(
            &app_type,
            Method::POST,
            endpoint,
            body,
            headers,
            extensions,
            ctx.get_providers(),
        )
        .await
        .map_err(|error| error.error)?;
    let connection_guard = result.connection_guard.take();
    ctx.provider = result.provider;
    ctx.outbound_model = result.outbound_model.take();
    let timeout = Duration::from_secs(1800);
    let (response_headers, status, bytes) =
        read_decoded_body(result.response, ctx.tag, timeout).await?;
    drop(connection_guard);
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes);
        return Err(ProxyError::UpstreamError {
            status: status.as_u16(),
            body: Some(body.chars().take(2000).collect()),
        });
    }
    parse_role_value(role.app_type, &response_headers, &bytes)
}

fn role_request_body(role: &ModelRef, prompt: &str, max_output_tokens: u64) -> Value {
    match role.app_type {
        ModelApp::Claude => json!({
            "model": role.model,
            "max_tokens": max_output_tokens,
            "stream": false,
            "messages": [{
                "role": "user",
                "content": [{"type": "text", "text": prompt}]
            }]
        }),
        ModelApp::Codex => json!({
            "model": role.model,
            "max_output_tokens": max_output_tokens,
            "stream": false,
            "input": [{
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}]
            }]
        }),
    }
}

fn worker_request_body(
    profile: &Profile,
    original_body: &Value,
    prompt: &str,
    max_output_tokens: u64,
    outer_protocol: ModelApp,
) -> Result<Value, ProxyError> {
    let mut body = match profile.worker.app_type {
        ModelApp::Claude => original_body.clone(),
        ModelApp::Codex => {
            if outer_protocol != ModelApp::Codex {
                return Err(ProxyError::TransformError(
                    "Cross-protocol tool requests cannot be bridged safely".to_string(),
                ));
            }
            if original_body.get("messages").is_some() && original_body.get("input").is_none() {
                openai_compat::chat_completions_request_to_codex_responses(original_body.clone())?
            } else {
                original_body.clone()
            }
        }
    };
    let object = body.as_object_mut().ok_or_else(|| {
        ProxyError::InvalidRequest("Orchestration request body must be an object".to_string())
    })?;
    object.insert(
        "model".to_string(),
        Value::String(profile.worker.model.clone()),
    );
    object.insert("stream".to_string(), Value::Bool(false));
    match profile.worker.app_type {
        ModelApp::Claude => {
            object.insert(
                "system".to_string(),
                merge_claude_system(object.get("system"), prompt),
            );
            object.insert(
                "max_tokens".to_string(),
                Value::Number(max_output_tokens.into()),
            );
        }
        ModelApp::Codex => {
            let instructions = object
                .get("instructions")
                .and_then(Value::as_str)
                .unwrap_or("");
            object.insert(
                "instructions".to_string(),
                Value::String(if instructions.trim().is_empty() {
                    prompt.to_string()
                } else {
                    format!("{instructions}\n\n{prompt}")
                }),
            );
            object.insert(
                "max_output_tokens".to_string(),
                Value::Number(max_output_tokens.into()),
            );
        }
    }
    Ok(body)
}

fn merge_claude_system(existing: Option<&Value>, prompt: &str) -> Value {
    match existing {
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Value::String(format!("{value}\n\n{prompt}"))
        }
        Some(Value::Array(blocks)) => {
            let mut merged = blocks.clone();
            merged.push(json!({"type": "text", "text": prompt}));
            Value::Array(merged)
        }
        _ => Value::String(prompt.to_string()),
    }
}

fn protocol_for_app(app: &AppType) -> Option<ModelApp> {
    match app {
        AppType::Claude | AppType::ClaudeDesktop => Some(ModelApp::Claude),
        AppType::Codex => Some(ModelApp::Codex),
        _ => None,
    }
}

fn parse_role_value(
    app_type: ModelApp,
    headers: &HeaderMap,
    bytes: &Bytes,
) -> Result<Value, ProxyError> {
    let body = String::from_utf8_lossy(bytes);
    let value = if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"))
        || body.trim_start().starts_with("event:")
        || body.trim_start().starts_with("data:")
    {
        parse_sse_response(app_type, &body)?
    } else {
        serde_json::from_slice(bytes).map_err(|error| {
            ProxyError::TransformError(format!("Failed to parse orchestration response: {error}"))
        })?
    };
    Ok(value)
}

fn parse_sse_response(app_type: ModelApp, body: &str) -> Result<Value, ProxyError> {
    let normalized = body.replace("\r\n", "\n");
    if matches!(app_type, ModelApp::Codex) {
        let mut completed = None;
        let mut deltas = String::new();
        for block in normalized.split("\n\n") {
            for line in block.lines() {
                let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("response.completed") => completed = value.get("response").cloned(),
                    Some("response.output_text.delta") => {
                        if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                            deltas.push_str(delta);
                        }
                    }
                    _ => {}
                }
            }
        }
        if let Some(mut value) = completed {
            if extract_response_text(ModelApp::Codex, &value).is_none() && !deltas.is_empty() {
                value["output_text"] = json!(deltas);
            }
            return Ok(value);
        }
        return Ok(json!({"output_text": deltas}));
    }

    let mut text = String::new();
    let mut final_value = None;
    for block in normalized.split("\n\n") {
        for line in block.lines() {
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(delta) = value
                .pointer("/delta/text")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/content_block/text").and_then(Value::as_str))
            {
                text.push_str(delta);
            }
            if value.get("type").and_then(Value::as_str) == Some("message_stop") {
                final_value = Some(value);
            }
        }
    }
    if let Some(value) = final_value {
        if extract_response_text(ModelApp::Claude, &value).is_some() {
            return Ok(value);
        }
    }
    Ok(json!({"content": [{"type": "text", "text": text}]}))
}

fn extract_response_text(app_type: ModelApp, value: &Value) -> Option<String> {
    let mut text = String::new();
    match app_type {
        ModelApp::Claude => {
            if let Some(content) = value.get("content").and_then(Value::as_array) {
                for block in content {
                    if let Some(part) = block.get("text").and_then(Value::as_str) {
                        text.push_str(part);
                    }
                }
            }
        }
        ModelApp::Codex => {
            if let Some(output_text) = value.get("output_text").and_then(Value::as_str) {
                text.push_str(output_text);
            }
            if let Some(output) = value.get("output").and_then(Value::as_array) {
                for item in output {
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for block in content {
                            if let Some(part) = block.get("text").and_then(Value::as_str) {
                                text.push_str(part);
                            }
                        }
                    }
                }
            }
            if let Some(choices) = value.get("choices").and_then(Value::as_array) {
                for choice in choices {
                    if let Some(part) = choice.pointer("/message/content").and_then(Value::as_str) {
                        text.push_str(part);
                    } else if let Some(parts) =
                        choice.pointer("/message/content").and_then(Value::as_array)
                    {
                        for part in parts {
                            if let Some(value) = part.get("text").and_then(Value::as_str) {
                                text.push_str(value);
                            }
                        }
                    }
                }
            }
        }
    }
    (!text.is_empty()).then_some(text)
}

fn extract_task_text(body: &Value) -> String {
    let mut text = String::new();
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if !matches!(role, "user" | "system") {
                continue;
            }
            append_content_text(&mut text, message.get("content"));
        }
    }
    if let Some(input) = body.get("input") {
        if let Some(input_text) = input.as_str() {
            text.push_str(input_text);
        } else if let Some(items) = input.as_array() {
            for item in items {
                if item.get("role").and_then(Value::as_str) == Some("user") {
                    append_content_text(&mut text, item.get("content"));
                }
            }
        }
    }
    let text = text.trim().to_string();
    if text.is_empty() && request_has_tools(body) {
        "Continue the current task using the tool results and conversation in this request."
            .to_string()
    } else {
        text
    }
}

fn append_content_text(output: &mut String, content: Option<&Value>) {
    let Some(content) = content else {
        return;
    };
    if let Some(value) = content.as_str() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(value);
    } else if let Some(blocks) = content.as_array() {
        for block in blocks {
            if let Some(value) = block
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| block.get("input_text").and_then(Value::as_str))
                .or_else(|| block.get("content").and_then(Value::as_str))
            {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(value);
            }
            if let Some(value) = block.get("output").and_then(Value::as_str) {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(value);
            }
        }
    }
}

fn verifier_accepts(verdict: &str) -> bool {
    let first = verdict.split_whitespace().next().unwrap_or("");
    matches!(
        first.to_ascii_lowercase().as_str(),
        "pass" | "passed" | "approved" | "approve" | "ok"
    )
}

fn request_has_tools(body: &Value) -> bool {
    body.get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty())
        || body.get("functions").is_some_and(|value| !value.is_null())
        || body.get("tool_choice").is_some()
}

fn has_tool_calls(app_type: ModelApp, value: &Value) -> bool {
    match app_type {
        ModelApp::Claude => value
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    matches!(
                        block.get("type").and_then(Value::as_str),
                        Some("tool_use" | "server_tool_use" | "computer_use")
                    )
                })
            }),
        ModelApp::Codex => {
            value
                .get("choices")
                .and_then(Value::as_array)
                .is_some_and(|choices| {
                    choices.iter().any(|choice| {
                        choice
                            .pointer("/message/tool_calls")
                            .and_then(Value::as_array)
                            .is_some_and(|calls| !calls.is_empty())
                            || choice.pointer("/message/function_call").is_some()
                    })
                })
                || value
                    .get("output")
                    .and_then(Value::as_array)
                    .is_some_and(|items| {
                        items.iter().any(|item| {
                            matches!(
                                item.get("type").and_then(Value::as_str),
                                Some(
                                    "function_call"
                                        | "custom_tool_call"
                                        | "tool_search_call"
                                        | "computer_call"
                                )
                            )
                        })
                    })
        }
    }
}

fn normalize_worker_value(original_body: &Value, mut worker_value: Value) -> Value {
    if let Some(model) = original_body.get("model").cloned() {
        worker_value["model"] = model;
    }
    if let Some(id) = worker_value.get("id").cloned() {
        if worker_value.get("object").is_none()
            && id.as_str().is_some_and(|value| value.starts_with("msg_"))
        {
            worker_value["id"] = id;
        }
    }
    worker_value
}

fn build_client_response(
    outer_app: &AppType,
    endpoint: &str,
    is_stream: bool,
    model: &str,
    answer: &str,
) -> Result<Response, ProxyError> {
    let is_chat = endpoint.contains("chat/completions");
    let value = if matches!(outer_app, AppType::Claude | AppType::ClaudeDesktop) {
        json!({
            "id": format!("msg_{}", uuid::Uuid::new_v4()),
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [{"type": "text", "text": answer}],
            "stop_reason": "end_turn",
            "stop_sequence": null,
            "usage": {"input_tokens": 0, "output_tokens": answer.chars().count()}
        })
    } else if is_chat {
        json!({
            "id": format!("chatcmpl-{}", uuid::Uuid::new_v4()),
            "object": "chat.completion",
            "created": chrono::Utc::now().timestamp(),
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": answer},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": answer.chars().count(), "total_tokens": answer.chars().count()}
        })
    } else {
        json!({
            "id": format!("resp_{}", uuid::Uuid::new_v4()),
            "object": "response",
            "created_at": chrono::Utc::now().timestamp(),
            "status": "completed",
            "model": model,
            "output_text": answer,
            "output": [{
                "id": format!("msg_{}", uuid::Uuid::new_v4()),
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": answer, "annotations": []}]
            }],
            "usage": {"input_tokens": 0, "output_tokens": answer.chars().count(), "total_tokens": answer.chars().count()}
        })
    };

    if !is_stream {
        return response_from_json(value);
    }
    let body = if matches!(outer_app, AppType::Claude | AppType::ClaudeDesktop) {
        anthropic_sse(&value, answer)?
    } else if is_chat {
        chat_sse(&value, answer)?
    } else {
        responses_sse(&value)?
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from(body))
        .map_err(|error| ProxyError::Internal(format!("Failed to build SSE response: {error}")))
}

fn build_client_tool_response(
    outer_app: &AppType,
    endpoint: &str,
    is_stream: bool,
    model: &str,
    mut value: Value,
) -> Result<Response, ProxyError> {
    value["model"] = Value::String(model.to_string());
    let value = if endpoint.contains("chat/completions") {
        openai_compat::codex_responses_to_chat_completion(value, model)?
    } else {
        value
    };
    if !is_stream {
        return response_from_json(value);
    }
    let body = if matches!(outer_app, AppType::Claude | AppType::ClaudeDesktop) {
        anthropic_tool_sse(&value)?
    } else if endpoint.contains("chat/completions") {
        chat_tool_sse(&value)?
    } else {
        responses_tool_sse(&value)?
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from(body))
        .map_err(|error| {
            ProxyError::Internal(format!("Failed to build tool SSE response: {error}"))
        })
}

fn response_from_json(value: Value) -> Result<Response, ProxyError> {
    let bytes = serde_json::to_vec(&value)
        .map_err(|error| ProxyError::Internal(format!("Failed to serialize response: {error}")))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(bytes))
        .map_err(|error| ProxyError::Internal(format!("Failed to build response: {error}")))
}

fn anthropic_sse(value: &Value, answer: &str) -> Result<Bytes, ProxyError> {
    let message_start = serde_json::to_string(&json!({
        "type": "message_start",
        "message": value
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    let block_start = serde_json::to_string(&json!({
        "type": "content_block_start",
        "index": 0,
        "content_block": {"type": "text", "text": ""}
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    let delta = serde_json::to_string(&json!({
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": answer}
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    let body = format!(
        "event: message_start\ndata: {message_start}\n\n\
         event: content_block_start\ndata: {block_start}\n\n\
         event: content_block_delta\ndata: {delta}\n\n\
         event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
         event: message_delta\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\",\"stop_sequence\":null}},\"usage\":{{\"output_tokens\":{}}}}}\n\n\
         event: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n",
        answer.chars().count()
    );
    Ok(Bytes::from(body))
}

fn anthropic_tool_sse(value: &Value) -> Result<Bytes, ProxyError> {
    let message_start = serde_json::to_string(&json!({
        "type": "message_start",
        "message": value
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    let mut body = format!("event: message_start\ndata: {message_start}\n\n");
    let blocks = value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, block) in blocks.iter().enumerate() {
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("tool_use");
        let start = serde_json::to_string(&json!({
            "type": "content_block_start",
            "index": index,
            "content_block": block
        }))
        .map_err(|error| ProxyError::Internal(error.to_string()))?;
        body.push_str(&format!("event: content_block_start\ndata: {start}\n\n"));
        if block_type == "tool_use" {
            if let Some(input) = block.get("input") {
                let input_json = serde_json::to_string(input)
                    .map_err(|error| ProxyError::Internal(error.to_string()))?;
                let delta = serde_json::to_string(&json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": {"type": "input_json_delta", "partial_json": input_json}
                }))
                .map_err(|error| ProxyError::Internal(error.to_string()))?;
                body.push_str(&format!("event: content_block_delta\ndata: {delta}\n\n"));
            }
        }
        let stop = serde_json::to_string(&json!({
            "type": "content_block_stop",
            "index": index
        }))
        .map_err(|error| ProxyError::Internal(error.to_string()))?;
        body.push_str(&format!("event: content_block_stop\ndata: {stop}\n\n"));
    }
    body.push_str(
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":0}}\n\n",
    );
    body.push_str("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    Ok(Bytes::from(body))
}

fn responses_sse(value: &Value) -> Result<Bytes, ProxyError> {
    let id = value
        .get("id")
        .cloned()
        .unwrap_or_else(|| json!("resp_ccswitch"));
    let model = value.get("model").cloned().unwrap_or_else(|| json!(""));
    let text = value
        .get("output_text")
        .and_then(Value::as_str)
        .unwrap_or("");
    let body = format!(
        "event: response.created\ndata: {}\n\n\
         event: response.in_progress\ndata: {}\n\n\
         event: response.output_text.delta\ndata: {}\n\n\
         event: response.completed\ndata: {}\n\n",
        serde_json::to_string(&json!({"type":"response.created","response":{"id":id,"object":"response","status":"in_progress","model":model,"output":[]}}))
            .map_err(|error| ProxyError::Internal(error.to_string()))?,
        serde_json::to_string(&json!({"type":"response.in_progress","response":{"id":id,"object":"response","status":"in_progress","model":model,"output":[]}}))
            .map_err(|error| ProxyError::Internal(error.to_string()))?,
        serde_json::to_string(&json!({"type":"response.output_text.delta","delta":text}))
            .map_err(|error| ProxyError::Internal(error.to_string()))?,
        serde_json::to_string(&json!({"type":"response.completed","response":value}))
            .map_err(|error| ProxyError::Internal(error.to_string()))?,
    );
    Ok(Bytes::from(body))
}

fn chat_sse(value: &Value, answer: &str) -> Result<Bytes, ProxyError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("chatcmpl-ccswitch");
    let model = value.get("model").and_then(Value::as_str).unwrap_or("");
    let chunk = serde_json::to_string(&json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": chrono::Utc::now().timestamp(),
        "model": model,
        "choices": [{"index":0,"delta":{"role":"assistant","content":answer},"finish_reason":null}]
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    let done = serde_json::to_string(&json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": chrono::Utc::now().timestamp(),
        "model": model,
        "choices": [{"index":0,"delta":{},"finish_reason":"stop"}]
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    Ok(Bytes::from(format!(
        "data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n"
    )))
}

fn chat_tool_sse(value: &Value) -> Result<Bytes, ProxyError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("chatcmpl-ccswitch");
    let model = value.get("model").and_then(Value::as_str).unwrap_or("");
    let tool_calls = value
        .pointer("/choices/0/message/tool_calls")
        .cloned()
        .or_else(|| {
            value
                .pointer("/choices/0/message/function_call")
                .map(|call| {
                    json!([{
                        "id": format!("call_{}", uuid::Uuid::new_v4()),
                        "type": "function",
                        "function": call
                    }])
                })
        })
        .unwrap_or_else(|| json!([]));
    let chunk = serde_json::to_string(&json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": chrono::Utc::now().timestamp(),
        "model": model,
        "choices": [{"index":0,"delta":{"role":"assistant","tool_calls":tool_calls},"finish_reason":null}]
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    let done = serde_json::to_string(&json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": chrono::Utc::now().timestamp(),
        "model": model,
        "choices": [{"index":0,"delta":{},"finish_reason":"tool_calls"}]
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    Ok(Bytes::from(format!(
        "data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n"
    )))
}

fn responses_tool_sse(value: &Value) -> Result<Bytes, ProxyError> {
    let id = value
        .get("id")
        .cloned()
        .unwrap_or_else(|| json!("resp_ccswitch"));
    let model = value.get("model").cloned().unwrap_or_else(|| json!(""));
    let output = value.get("output").cloned().unwrap_or_else(|| json!([]));
    let created = serde_json::to_string(&json!({
        "type": "response.created",
        "response": {"id": id, "object": "response", "status": "in_progress", "model": model, "output": []}
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    let mut body = format!("event: response.created\ndata: {created}\n\n");
    if let Some(items) = output.as_array() {
        for (index, item) in items.iter().enumerate() {
            let added = serde_json::to_string(&json!({
                "type": "response.output_item.added",
                "output_index": index,
                "item": item
            }))
            .map_err(|error| ProxyError::Internal(error.to_string()))?;
            body.push_str(&format!(
                "event: response.output_item.added\ndata: {added}\n\n"
            ));
            let done = serde_json::to_string(&json!({
                "type": "response.output_item.done",
                "output_index": index,
                "item": item
            }))
            .map_err(|error| ProxyError::Internal(error.to_string()))?;
            body.push_str(&format!(
                "event: response.output_item.done\ndata: {done}\n\n"
            ));
        }
    }
    let completed = serde_json::to_string(&json!({
        "type": "response.completed",
        "response": value
    }))
    .map_err(|error| ProxyError::Internal(error.to_string()))?;
    body.push_str(&format!("event: response.completed\ndata: {completed}\n\n"));
    Ok(Bytes::from(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_from_supported_request_shapes() {
        let claude = json!({
            "messages": [
                {"role": "system", "content": "Be precise."},
                {"role": "user", "content": [
                    {"type": "text", "text": "Implement the feature."}
                ]}
            ]
        });
        assert_eq!(
            extract_task_text(&claude),
            "Be precise.\nImplement the feature."
        );

        let responses = json!({
            "input": [
                {"role": "user", "content": [
                    {"type": "input_text", "text": "Verify the result."}
                ]}
            ]
        });
        assert_eq!(extract_task_text(&responses), "Verify the result.");
    }

    #[test]
    fn parses_sse_without_double_counting_deltas() {
        let claude = "event: content_block_delta\r\ndata: {\"delta\":{\"text\":\"one\"}}\r\n\r\n\
                      event: content_block_delta\r\ndata: {\"delta\":{\"text\":\" two\"}}\r\n\r\n\
                      event: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n";
        let value = parse_sse_response(ModelApp::Claude, claude).unwrap();
        assert_eq!(
            extract_response_text(ModelApp::Claude, &value).as_deref(),
            Some("one two")
        );

        let codex = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"one\"}\n\n\
                     data: {\"type\":\"response.output_text.delta\",\"delta\":\" two\"}\n\n\
                     data: [DONE]\n\n";
        let value = parse_sse_response(ModelApp::Codex, codex).unwrap();
        assert_eq!(
            extract_response_text(ModelApp::Codex, &value).as_deref(),
            Some("one two")
        );
    }

    #[test]
    fn accepts_only_pass_like_verdicts() {
        assert!(verifier_accepts("PASS - all checks green"));
        assert!(verifier_accepts("approved"));
        assert!(!verifier_accepts("FAIL: missing tests"));
        assert!(!verifier_accepts("The result is probably okay"));
    }

    #[test]
    fn cancellation_registry_is_request_scoped() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        assert!(!is_cancelled(&id));
        assert!(request_cancel(&id));
        assert!(is_cancelled(&id));
        assert!(!request_cancel(&id));
        clear_cancel(&id);
        assert!(!is_cancelled(&id));
    }

    #[test]
    fn detects_tool_requests_and_protocol_native_tool_calls() {
        let request = json!({
            "tools": [{"type": "function", "function": {"name": "read_file"}}],
            "tool_choice": "auto"
        });
        assert!(request_has_tools(&request));
        assert!(!request_has_tools(
            &json!({"messages": [{"role": "user", "content": "hi"}]})
        ));

        let claude = json!({
            "content": [{"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {}}]
        });
        assert!(has_tool_calls(ModelApp::Claude, &claude));

        let codex = json!({
            "output": [{"type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "{}"}]
        });
        assert!(has_tool_calls(ModelApp::Codex, &codex));
    }

    #[test]
    fn worker_tool_body_uses_the_matching_protocol_shape() {
        let mut profile = crate::orchestration::fixture().profiles[0].clone();
        let chat_request = json!({
            "model": "ccsm-orch/test",
            "messages": [{"role": "user", "content": "Inspect the repository."}],
            "tools": [{"type": "function", "function": {"name": "read_file"}}]
        });
        let codex_body = worker_request_body(
            &profile,
            &chat_request,
            "Follow the plan.",
            4096,
            ModelApp::Codex,
        )
        .unwrap();
        assert!(codex_body.get("input").is_some());
        assert!(codex_body.get("messages").is_none());
        assert_eq!(codex_body["stream"], json!(false));

        let error = worker_request_body(
            &profile,
            &chat_request,
            "Follow the plan.",
            4096,
            ModelApp::Claude,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("Cross-protocol tool requests cannot be bridged safely"));

        profile.worker.app_type = ModelApp::Claude;
        let claude_body = worker_request_body(
            &profile,
            &chat_request,
            "Follow the plan.",
            4096,
            ModelApp::Claude,
        )
        .unwrap();
        assert!(claude_body.get("messages").is_some());
        assert!(claude_body["system"]
            .as_str()
            .is_some_and(|value| value.contains("Follow the plan.")));
    }

    #[test]
    fn claude_desktop_uses_claude_protocol_for_orchestration() {
        assert_eq!(
            protocol_for_app(&AppType::ClaudeDesktop),
            Some(ModelApp::Claude)
        );
        assert!(resolve_route(
            &crate::orchestration::fixture(),
            "claude-desktop",
            "ccsm-orch/test"
        )
        .is_ok());
    }

    #[test]
    fn tool_continuation_without_new_user_text_still_has_a_planner_task() {
        let body = json!({
            "tools": [{"type": "function", "function": {"name": "read_file"}}],
            "messages": [{
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}]
            }]
        });
        assert_eq!(extract_task_text(&body), "ok");
    }

    #[test]
    fn chat_tool_response_projects_from_codex_responses_shape() {
        let response = build_client_tool_response(
            &AppType::Codex,
            "/chat/completions",
            false,
            "ccsm-orch/test",
            json!({
                "id": "resp_1",
                "model": "worker",
                "output": [{
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "read_file",
                    "arguments": "{\"path\":\"README.md\"}"
                }]
            }),
        )
        .unwrap();
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
    }
}
