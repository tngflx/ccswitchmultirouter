use super::codex_chat_common::{is_empty_value, response_item_call_id};
use crate::proxy::sse::{strip_sse_field, TextSseFrames};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use tokio::sync::RwLock;

const MAX_CACHED_RESPONSES: usize = 512;
const MAX_CACHED_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
struct CachedResponse {
    prefix: Arc<CachedItems>,
    exchange: Arc<CachedItems>,
    calls_by_id: HashMap<String, CachedCall>,
    sequence: u64,
    byte_size: usize,
}

#[derive(Debug, Default)]
struct CachedItems {
    items: Vec<Value>,
    byte_size: usize,
}

impl CachedItems {
    fn new(items: Vec<Value>) -> Self {
        let byte_size = items.iter().map(value_size).sum();
        Self { items, byte_size }
    }
}

#[derive(Debug, Clone)]
struct CachedCall {
    item: Arc<Value>,
    position: usize,
    byte_size: usize,
}

impl CachedCall {
    fn new(item: Value) -> Self {
        let byte_size = value_size(&item);
        Self {
            item: Arc::new(item),
            position: 0,
            byte_size,
        }
    }
}

#[derive(Debug, Default)]
struct CodexChatHistoryInner {
    responses: HashMap<Arc<str>, Arc<CachedResponse>>,
    response_order: VecDeque<Arc<str>>,
    call_index: HashMap<String, HashSet<Arc<str>>>,
    next_sequence: u64,
    cached_bytes: usize,
}

#[derive(Debug, Clone, Default)]
struct CachedLookup {
    previous: Option<Arc<CachedResponse>>,
    fallback: HashMap<String, (u64, CachedCall)>,
}

/// Cross-request history needed when Codex Responses is bridged to Chat
/// Completions.
///
/// Chat providers such as DeepSeek require an assistant message with the
/// original tool call and its `reasoning_content` immediately before the tool
/// result. Codex often sends follow-up requests as
/// `previous_response_id + function_call_output`, so this store restores the
/// missing function call before the request is converted to Chat messages.
/// Some Codex flows such as subagents may omit or rewrite
/// `previous_response_id`, so the store can also fall back to a uniquely
/// cached `call_id`.
#[derive(Debug, Default)]
pub struct CodexChatHistoryStore {
    inner: RwLock<CodexChatHistoryInner>,
}

impl CodexChatHistoryStore {
    pub async fn record_response(&self, response: &Value) -> usize {
        self.record_exchange(&Value::Null, response).await
    }

    pub async fn record_exchange(&self, request: &Value, response: &Value) -> usize {
        let Some(response_id) = response
            .get("id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
        else {
            return 0;
        };

        let response_output_items = response
            .get("output")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let calls = response_output_items
            .iter()
            .filter_map(cached_call_item)
            .collect::<Vec<_>>();
        let prefix_items = cached_prefix_items(request);
        let exchange_items = cached_exchange_items(&prefix_items, response_output_items);

        if calls.is_empty() && exchange_items.is_empty() {
            return 0;
        }

        let prefix = CachedItems::new(prefix_items);
        let exchange = CachedItems::new(exchange_items);
        let mut inner = self.inner.write().await;
        inner.insert_exchange(response_id, prefix, exchange, calls)
    }

    async fn record_call_item(&self, response_id: Option<&str>, item: &Value) -> bool {
        let Some(response_id) = response_id.filter(|value| !value.is_empty()) else {
            return false;
        };
        let Some(call) = cached_call_item(item) else {
            return false;
        };
        let mut inner = self.inner.write().await;
        inner.insert_calls(response_id, vec![call]) > 0
    }

    pub async fn enrich_request(&self, body: &mut Value) -> usize {
        let previous_response_id = body
            .get("previous_response_id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let Some(input) = body.get_mut("input") else {
            return 0;
        };

        let original_input = std::mem::take(input);
        let original_was_object = matches!(&original_input, Value::Object(_));
        let items = match original_input {
            Value::Array(items) => items,
            Value::Object(object) => vec![Value::Object(object)],
            other => {
                *input = other;
                return 0;
            }
        };

        let output_call_ids = items
            .iter()
            .filter(|item| {
                item.get("type")
                    .and_then(|value| value.as_str())
                    .is_some_and(is_call_output_item_type)
            })
            .filter_map(response_item_call_id)
            .collect::<HashSet<_>>();
        let existing_call_ids = items
            .iter()
            .filter(|item| {
                item.get("type")
                    .and_then(|value| value.as_str())
                    .is_some_and(is_call_item_type)
            })
            .filter_map(response_item_call_id)
            .collect::<HashSet<_>>();
        let requested_call_ids = output_call_ids
            .union(&existing_call_ids)
            .cloned()
            .collect::<HashSet<_>>();
        let has_context_items = items.iter().any(|item| {
            item.get("type")
                .and_then(|value| value.as_str())
                .is_none_or(|item_type| !is_call_output_item_type(item_type))
        });
        let has_tool_output = !output_call_ids.is_empty();
        let lookup = self
            .lookup(previous_response_id.as_deref(), &requested_call_ids)
            .await;

        let restore_group = lookup.restore_group(&output_call_ids, &existing_call_ids);
        let mut restore_group = Some(restore_group);
        let mut seen_call_ids = HashSet::new();
        let mut restored = 0usize;
        let mut enriched = 0usize;
        let mut new_items = Vec::new();

        if !has_tool_output {
            let exchange_items = lookup.restore_exchange();
            if !exchange_items.is_empty() {
                restored += exchange_items.len();
                new_items.extend(exchange_items);
            }
        }

        for mut item in items {
            match item.get("type").and_then(|value| value.as_str()) {
                Some(item_type) if is_call_item_type(item_type) => {
                    if let Some(call_id) = response_item_call_id(&item) {
                        if let Some(cached) = lookup.call(&call_id) {
                            if enrich_call_item_from_cache(&mut item, cached) {
                                enriched += 1;
                            }
                        }
                        seen_call_ids.insert(call_id);
                    }
                    new_items.push(item);
                }
                Some(item_type) if is_call_output_item_type(item_type) => {
                    if let Some(group) = restore_group.take().filter(|group| !group.is_empty()) {
                        if !has_context_items {
                            new_items.extend(lookup.restore_prefix());
                        }
                        for (call_id, cached_item) in group {
                            seen_call_ids.insert(call_id);
                            new_items.push(cached_item);
                            restored += 1;
                        }
                    }

                    if let Some(call_id) = response_item_call_id(&item) {
                        if !seen_call_ids.contains(&call_id) {
                            if let Some(cached) = lookup.call(&call_id).cloned() {
                                seen_call_ids.insert(call_id);
                                new_items.push(cached);
                                restored += 1;
                            }
                        }
                    }
                    new_items.push(item);
                }
                _ => new_items.push(item),
            }
        }

        let changed = restored + enriched;
        if changed == 0 && original_was_object && new_items.len() == 1 {
            *input = new_items.into_iter().next().unwrap_or(Value::Null);
        } else {
            *input = Value::Array(new_items);
        }
        changed
    }

    async fn lookup(
        &self,
        previous_response_id: Option<&str>,
        requested_call_ids: &HashSet<String>,
    ) -> CachedLookup {
        let inner = self.inner.read().await;
        let previous = previous_response_id.and_then(|id| inner.responses.get(id).cloned());
        let fallback = inner.unique_fallback_calls(requested_call_ids, previous.as_deref());
        CachedLookup { previous, fallback }
    }
}

impl CodexChatHistoryInner {
    fn insert_calls(&mut self, response_id: &str, calls: Vec<(String, CachedCall)>) -> usize {
        self.insert_exchange(
            response_id,
            CachedItems::default(),
            CachedItems::default(),
            calls,
        )
    }

    fn insert_exchange(
        &mut self,
        response_id: &str,
        prefix: CachedItems,
        exchange: CachedItems,
        calls: Vec<(String, CachedCall)>,
    ) -> usize {
        let (response_id, previous_size) =
            if let Some((id, response)) = self.responses.get_key_value(response_id) {
                (Arc::clone(id), response.byte_size)
            } else {
                let id: Arc<str> = Arc::from(response_id);
                self.response_order.push_back(Arc::clone(&id));
                self.responses.insert(
                    Arc::clone(&id),
                    Arc::new(CachedResponse {
                        sequence: self.next_sequence,
                        byte_size: response_id.len() + std::mem::size_of::<CachedResponse>(),
                        ..CachedResponse::default()
                    }),
                );
                self.next_sequence += 1;
                (id, 0)
            };

        let cached_response = self
            .responses
            .get_mut(&response_id)
            .expect("response was inserted");
        let cached_response = Arc::make_mut(cached_response);
        if !prefix.items.is_empty() {
            cached_response.byte_size -= cached_response.prefix.byte_size;
            cached_response.byte_size += prefix.byte_size;
            cached_response.prefix = Arc::new(prefix);
        }
        if !exchange.items.is_empty() {
            cached_response.byte_size -= cached_response.exchange.byte_size;
            cached_response.byte_size += exchange.byte_size;
            cached_response.exchange = Arc::new(exchange);
        }
        let inserted_or_updated = calls.len();
        for (call_id, mut call) in calls {
            let next_position = cached_response.calls_by_id.len();
            match cached_response.calls_by_id.entry(call_id) {
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    call.position = entry.get().position;
                    cached_response.byte_size -= entry.get().byte_size;
                    cached_response.byte_size += call.byte_size;
                    entry.insert(call);
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    call.position = next_position;
                    cached_response.byte_size += call.byte_size
                        + 2 * entry.key().len()
                        + std::mem::size_of::<CachedCall>()
                        + std::mem::size_of::<Arc<str>>();
                    self.call_index
                        .entry(entry.key().clone())
                        .or_default()
                        .insert(Arc::clone(&response_id));
                    entry.insert(call);
                }
            }
        }

        self.cached_bytes = self.cached_bytes - previous_size + cached_response.byte_size;
        if cached_response.byte_size > MAX_CACHED_BYTES {
            // Drop this entry directly so an oversized exchange cannot flush unrelated history.
            self.response_order.retain(|id| id != &response_id);
            self.remove_response(&response_id);
            return 0;
        }
        self.prune();
        inserted_or_updated
    }

    fn prune(&mut self) {
        while self.response_order.len() > MAX_CACHED_RESPONSES
            || self.cached_bytes > MAX_CACHED_BYTES
        {
            let Some(response_id) = self.response_order.pop_front() else {
                break;
            };
            self.remove_response(&response_id);
        }
    }

    fn remove_response(&mut self, response_id: &str) {
        let Some(response) = self.responses.remove(response_id) else {
            return;
        };
        self.cached_bytes -= response.byte_size;
        for call_id in response.calls_by_id.keys() {
            let should_remove = self
                .call_index
                .get_mut(call_id)
                .map(|response_ids| {
                    response_ids.remove(response_id);
                    response_ids.is_empty()
                })
                .unwrap_or(false);
            if should_remove {
                self.call_index.remove(call_id);
            }
        }
    }

    fn unique_fallback_calls(
        &self,
        requested_call_ids: &HashSet<String>,
        previous: Option<&CachedResponse>,
    ) -> HashMap<String, (u64, CachedCall)> {
        requested_call_ids
            .iter()
            .filter(|call_id| {
                !previous.is_some_and(|response| response.calls_by_id.contains_key(*call_id))
            })
            .filter_map(|call_id| {
                self.unique_call(call_id)
                    .map(|(sequence, call)| (call_id.clone(), (sequence, call.clone())))
            })
            .collect()
    }

    fn unique_call(&self, call_id: &str) -> Option<(u64, &CachedCall)> {
        let response_ids = self.call_index.get(call_id)?;
        if response_ids.len() != 1 {
            return None;
        }
        let response = self.responses.get(response_ids.iter().next()?)?;
        let call = response.calls_by_id.get(call_id)?;
        Some((response.sequence, call))
    }
}

fn value_size(value: &Value) -> usize {
    #[cfg(test)]
    VALUE_SIZE_VISITS.with(|visits| visits.set(visits.get() + 1));

    let children = match value {
        Value::String(text) => text.capacity(),
        Value::Array(values) => {
            let unused_slots = values.capacity() - values.len();
            unused_slots * std::mem::size_of::<Value>()
                + values.iter().map(value_size).sum::<usize>()
        }
        Value::Object(object) => object
            .iter()
            .map(|(key, value)| std::mem::size_of::<String>() + key.capacity() + value_size(value))
            .sum(),
        _ => 0,
    };
    std::mem::size_of::<Value>() + children
}

#[cfg(test)]
thread_local! {
    static VALUE_SIZE_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl CachedLookup {
    fn restore_exchange(&self) -> Vec<Value> {
        self.previous
            .as_ref()
            .map(|previous| previous.exchange.items.clone())
            .unwrap_or_default()
    }

    fn restore_prefix(&self) -> Vec<Value> {
        self.previous
            .as_ref()
            .map(|previous| previous.prefix.items.clone())
            .unwrap_or_default()
    }

    fn call(&self, call_id: &str) -> Option<&Value> {
        self.ordered_call(call_id)
            .map(|(_, _, call)| call.item.as_ref())
    }

    fn ordered_call(&self, call_id: &str) -> Option<(bool, u64, &CachedCall)> {
        self.previous
            .as_ref()
            .and_then(|previous| {
                previous
                    .calls_by_id
                    .get(call_id)
                    .map(|call| (false, previous.sequence, call))
            })
            .or_else(|| {
                self.fallback
                    .get(call_id)
                    .map(|(sequence, call)| (true, *sequence, call))
            })
    }

    fn restore_group(
        &self,
        output_call_ids: &HashSet<String>,
        existing_call_ids: &HashSet<String>,
    ) -> Vec<(String, Value)> {
        let mut group = output_call_ids
            .difference(existing_call_ids)
            .filter_map(|call_id| {
                self.ordered_call(call_id)
                    .map(|(fallback, sequence, call)| {
                        (
                            (fallback, sequence, call.position),
                            call_id,
                            call.item.as_ref(),
                        )
                    })
            })
            .collect::<Vec<_>>();
        group.sort_unstable_by_key(|(order, _, _)| *order);
        group
            .into_iter()
            .map(|(_, id, item)| (id.clone(), item.clone()))
            .collect()
    }
}

fn cached_prefix_items(request: &Value) -> Vec<Value> {
    let Some(input) = request.get("input") else {
        return Vec::new();
    };
    let items = match input {
        Value::Array(items) => items.as_slice(),
        Value::Object(_) => std::slice::from_ref(input),
        _ => return Vec::new(),
    };

    items
        .iter()
        .filter(|item| {
            item.get("type")
                .and_then(|value| value.as_str())
                .is_none_or(|item_type| !is_call_output_item_type(item_type))
        })
        .cloned()
        .collect()
}

fn cached_exchange_items(prefix_items: &[Value], response_output_items: &[Value]) -> Vec<Value> {
    let mut items = Vec::with_capacity(prefix_items.len() + response_output_items.len());
    items.extend(prefix_items.iter().cloned());
    items.extend(response_output_items.iter().cloned());
    items
}

pub fn record_responses_sse_stream(
    stream: impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
    history: Arc<CodexChatHistoryStore>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    record_responses_sse_stream_with_request(stream, history, Value::Null)
}

pub fn record_responses_sse_stream_with_request(
    stream: impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
    history: Arc<CodexChatHistoryStore>,
    request: Value,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let mut frames = TextSseFrames::default();
        let mut current_response_id: Option<String> = None;

        tokio::pin!(stream);

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    frames.push(&bytes);
                    while let Some(block) = frames.next_block() {
                        inspect_sse_block(
                            &block,
                            &mut current_response_id,
                            history.as_ref(),
                            &request,
                        )
                        .await;
                    }
                    yield Ok(bytes);
                }
                Err(err) => yield Err(err),
            }
        }
    }
}

async fn inspect_sse_block(
    block: &str,
    current_response_id: &mut Option<String>,
    history: &CodexChatHistoryStore,
    request: &Value,
) {
    if block.trim().is_empty() {
        return;
    }

    let mut data_parts = Vec::new();
    for line in block.lines() {
        if let Some(data) = strip_sse_field(line, "data") {
            data_parts.push(data.to_string());
        }
    }

    let data = data_parts.join("\n");
    if data.trim().is_empty() || data.trim() == "[DONE]" {
        return;
    }

    let Ok(value) = serde_json::from_str::<Value>(&data) else {
        return;
    };

    record_responses_sse_event(&value, current_response_id, history, request).await;
}

pub(crate) async fn record_responses_sse_event(
    value: &Value,
    current_response_id: &mut Option<String>,
    history: &CodexChatHistoryStore,
    request: &Value,
) {
    if let Some(response_id) = value
        .pointer("/response/id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
    {
        *current_response_id = Some(response_id.to_string());
    }

    match value.get("type").and_then(|value| value.as_str()) {
        Some("response.output_item.done") => {
            if let Some(item) = value.get("item") {
                history
                    .record_call_item(current_response_id.as_deref(), item)
                    .await;
            }
        }
        Some("response.completed") => {
            if let Some(response) = value.get("response") {
                if request.is_null() {
                    history.record_response(response).await;
                } else {
                    history.record_exchange(request, response).await;
                }
            }
        }
        _ => {}
    }
}

fn cached_call_item(item: &Value) -> Option<(String, CachedCall)> {
    if !item
        .get("type")
        .and_then(|value| value.as_str())
        .is_some_and(is_call_item_type)
    {
        return None;
    }
    let call_id = response_item_call_id(item)?;
    Some((call_id, CachedCall::new(item.clone())))
}

fn is_call_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call" | "custom_tool_call" | "tool_search_call"
    )
}

fn is_call_output_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call_output" | "custom_tool_call_output" | "tool_search_output"
    )
}

fn enrich_call_item_from_cache(item: &mut Value, cached: &Value) -> bool {
    let mut changed = false;
    for key in [
        "name",
        "namespace",
        "arguments",
        "input",
        "status",
        "execution",
        "reasoning_content",
        "reasoning",
    ] {
        if item.get(key).is_some_and(|value| !is_empty_value(value)) {
            continue;
        }
        let Some(value) = cached.get(key).filter(|value| !is_empty_value(value)) else {
            continue;
        };
        if let Some(object) = item.as_object_mut() {
            object.insert(key.to_string(), value.clone());
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use serde_json::json;

    #[tokio::test]
    async fn enriches_tool_output_with_cached_function_call_from_previous_response() {
        let history = CodexChatHistoryStore::default();
        history
            .record_response(&json!({
                "id": "resp_1",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}",
                        "reasoning_content": "Need to inspect the file."
                    }
                ]
            }))
            .await;

        let mut request = json!({
            "previous_response_id": "resp_1",
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });

        assert_eq!(history.enrich_request(&mut request).await, 1);
        let input = request["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["reasoning_content"], "Need to inspect the file.");
        assert_eq!(input[1]["type"], "function_call_output");
    }

    #[tokio::test]
    async fn restores_unique_call_id_without_matching_previous_response() {
        let history = CodexChatHistoryStore::default();
        history
            .record_response(&json!({
                "id": "resp_1",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "read_file",
                        "arguments": "{}",
                        "reasoning_content": "This is the only cached call."
                    }
                ]
            }))
            .await;

        let mut missing_previous = json!({
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });
        assert_eq!(history.enrich_request(&mut missing_previous).await, 1);
        assert_eq!(missing_previous["input"][0]["type"], "function_call");
        assert_eq!(
            missing_previous["input"][0]["reasoning_content"],
            "This is the only cached call."
        );
        assert_eq!(missing_previous["input"][1]["type"], "function_call_output");

        let mut different_previous = json!({
            "previous_response_id": "resp_2",
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });
        assert_eq!(history.enrich_request(&mut different_previous).await, 1);
        assert_eq!(different_previous["input"][0]["type"], "function_call");
        assert_eq!(
            different_previous["input"][0]["reasoning_content"],
            "This is the only cached call."
        );
        assert_eq!(
            different_previous["input"][1]["type"],
            "function_call_output"
        );
    }

    #[tokio::test]
    async fn does_not_restore_ambiguous_call_id_without_previous_response() {
        let history = CodexChatHistoryStore::default();
        for (response_id, reasoning) in [
            ("resp_1", "This belongs to the first response."),
            ("resp_2", "This belongs to the second response."),
        ] {
            history
                .record_response(&json!({
                    "id": response_id,
                    "output": [
                        {
                            "type": "function_call",
                            "call_id": "call_1",
                            "name": "read_file",
                            "arguments": "{}",
                            "reasoning_content": reasoning
                        }
                    ]
                }))
                .await;
        }

        let mut missing_previous = json!({
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });
        assert_eq!(history.enrich_request(&mut missing_previous).await, 0);
        assert_eq!(missing_previous["input"][0]["type"], "function_call_output");

        let mut different_previous = json!({
            "previous_response_id": "resp_missing",
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });
        assert_eq!(history.enrich_request(&mut different_previous).await, 0);
        assert_eq!(
            different_previous["input"][0]["type"],
            "function_call_output"
        );
    }

    #[tokio::test]
    async fn enriches_existing_function_call_missing_reasoning() {
        let history = CodexChatHistoryStore::default();
        history
            .record_response(&json!({
                "id": "resp_1",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "read_file",
                        "arguments": "{}",
                        "reasoning_content": "Need to inspect the file."
                    }
                ]
            }))
            .await;

        let mut request = json!({
            "previous_response_id": "resp_1",
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "read_file",
                    "arguments": "{}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });

        assert_eq!(history.enrich_request(&mut request).await, 1);
        let input = request["input"].as_array().unwrap();
        assert_eq!(input[0]["reasoning_content"], "Need to inspect the file.");
        assert_eq!(input.len(), 2);
    }

    #[tokio::test]
    async fn enriches_existing_function_call_missing_name_and_arguments() {
        let history = CodexChatHistoryStore::default();
        history
            .record_response(&json!({
                "id": "resp_1",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}",
                        "reasoning_content": "Need to inspect the file."
                    }
                ]
            }))
            .await;

        let mut request = json!({
            "previous_response_id": "resp_1",
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call_1"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });

        assert_eq!(history.enrich_request(&mut request).await, 1);
        let input = request["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["name"], "read_file");
        assert_eq!(input[0]["arguments"], "{\"path\":\"README.md\"}");
        assert_eq!(input[0]["reasoning_content"], "Need to inspect the file.");
        assert_eq!(input[1]["type"], "function_call_output");
    }

    #[tokio::test]
    async fn restores_parallel_tool_calls_as_one_assistant_group() {
        let history = CodexChatHistoryStore::default();
        history
            .record_response(&json!({
                "id": "resp_1",
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "first",
                        "arguments": "{}",
                        "reasoning_content": "Need both tools."
                    },
                    {
                        "type": "function_call",
                        "call_id": "call_2",
                        "name": "second",
                        "arguments": "{}",
                        "reasoning_content": "Need both tools."
                    }
                ]
            }))
            .await;

        let mut request = json!({
            "previous_response_id": "resp_1",
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "one"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_2",
                    "output": "two"
                }
            ]
        });

        assert_eq!(history.enrich_request(&mut request).await, 2);
        let input = request["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["call_id"], "call_1");
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "call_2");
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[3]["type"], "function_call_output");
    }

    #[test]
    fn cache_prunes_by_retained_bytes_without_flushing_on_oversized_updates() {
        let mut inner = CodexChatHistoryInner::default();
        let call = |id: &str, bytes: usize| {
            (
                id.to_string(),
                CachedCall::new(Value::String("x".repeat(bytes))),
            )
        };
        inner.insert_calls("resp_1", vec![call("first", MAX_CACHED_BYTES / 2)]);
        inner.insert_calls("resp_2", vec![call("second", MAX_CACHED_BYTES / 2)]);
        assert!(inner.cached_bytes <= MAX_CACHED_BYTES);
        assert!(!inner.responses.contains_key("resp_1"));
        assert!(!inner.call_index.contains_key("first"));
        let retained_bytes = inner.cached_bytes;

        inner.insert_calls("resp_3", vec![call("third", 0)]);
        assert_eq!(
            inner.insert_calls("resp_3", vec![call("third", MAX_CACHED_BYTES)]),
            0
        );
        assert_eq!(inner.responses.len(), 1);
        assert_eq!(inner.response_order.len(), 1);
        assert!(!inner.call_index.contains_key("third"));
        assert!(inner.unique_call("second").is_some());
        assert_eq!(inner.cached_bytes, retained_bytes);
    }

    #[test]
    fn count_eviction_recovers_unique_calls_without_reordering_updates() {
        let mut inner = CodexChatHistoryInner::default();
        let call = |id: &str, text: &str| (id.to_string(), CachedCall::new(json!(text)));
        inner.insert_calls("old", vec![call("shared", "old")]);
        inner.insert_calls(
            "new",
            vec![
                call("first-in-new", "initial"),
                call("shared", "replacement"),
            ],
        );
        inner.insert_calls("new", vec![call("first-in-new", "updated")]);
        assert!(inner.unique_call("shared").is_none());
        let new_response = inner.responses.get("new").unwrap();
        assert_eq!(new_response.calls_by_id["first-in-new"].position, 0);
        assert_eq!(new_response.calls_by_id["shared"].position, 1);
        for index in 0..MAX_CACHED_RESPONSES - 1 {
            inner.insert_calls(
                &format!("response-{index}"),
                vec![call("unrelated", "value")],
            );
        }
        assert_eq!(inner.responses.len(), MAX_CACHED_RESPONSES);
        assert_eq!(inner.call_index["shared"].len(), 1);
        assert_eq!(
            inner.unique_call("shared").unwrap().1.item.as_ref(),
            &json!("replacement")
        );
    }

    #[test]
    fn repeated_call_updates_size_only_new_items() {
        for history_size in [1, 1024] {
            let mut inner = CodexChatHistoryInner::default();
            let items = CachedItems::new(vec![json!({"text": "history"}); history_size]);
            inner.insert_exchange("response", CachedItems::default(), items, Vec::new());
            VALUE_SIZE_VISITS.with(|visits| visits.set(0));
            for index in 0..32 {
                let call = CachedCall::new(json!({"nested": [index, "argument"]}));
                inner.insert_calls("response", vec![("call".into(), call)]);
            }
            assert_eq!(VALUE_SIZE_VISITS.with(std::cell::Cell::get), 32 * 4);
            assert_eq!(
                inner
                    .responses
                    .get("response")
                    .unwrap()
                    .exchange
                    .items
                    .len(),
                history_size
            );
        }
    }

    #[test]
    fn fallback_group_keeps_response_and_call_order_with_previous_first() {
        let mut inner = CodexChatHistoryInner::default();
        for (response_id, calls) in [
            ("older", vec!["b", "a"]),
            ("previous", vec!["d", "c"]),
            ("newest", vec!["f", "e"]),
        ] {
            inner.insert_calls(
                response_id,
                calls
                    .into_iter()
                    .map(|id| (id.to_string(), CachedCall::new(json!(id))))
                    .collect(),
            );
        }
        let lookup_ids = ["a", "b", "c", "d", "e", "f"]
            .map(String::from)
            .into_iter()
            .collect();
        let previous = inner.responses.get("previous").cloned();
        let lookup = CachedLookup {
            fallback: inner.unique_fallback_calls(&lookup_ids, previous.as_deref()),
            previous,
        };
        let order = lookup
            .restore_group(&lookup_ids, &HashSet::new())
            .into_iter()
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        assert_eq!(order, ["d", "c", "b", "a", "f", "e"]);
    }

    #[tokio::test]
    async fn restores_custom_and_tool_search_calls_from_previous_response() {
        let history = CodexChatHistoryStore::default();
        history
            .record_response(&json!({
                "id": "resp_1",
                "output": [
                    {
                        "type": "custom_tool_call",
                        "call_id": "call_patch",
                        "name": "apply_patch",
                        "input": "*** Begin Patch\n*** End Patch",
                        "reasoning_content": "Need to patch the file."
                    },
                    {
                        "type": "tool_search_call",
                        "call_id": "call_search",
                        "status": "completed",
                        "execution": "client",
                        "arguments": {"query": "Gmail tools"},
                        "reasoning_content": "Need to discover tools."
                    }
                ]
            }))
            .await;

        let mut request = json!({
            "previous_response_id": "resp_1",
            "input": [
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call_patch",
                    "output": "patched"
                },
                {
                    "type": "tool_search_output",
                    "call_id": "call_search",
                    "tools": []
                }
            ]
        });

        assert_eq!(history.enrich_request(&mut request).await, 2);
        let input = request["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "custom_tool_call");
        assert_eq!(input[0]["call_id"], "call_patch");
        assert_eq!(input[1]["type"], "tool_search_call");
        assert_eq!(input[1]["call_id"], "call_search");
        assert_eq!(input[2]["type"], "custom_tool_call_output");
        assert_eq!(input[3]["type"], "tool_search_output");
    }

    #[tokio::test]
    async fn records_streamed_function_call_done_items() {
        let history = Arc::new(CodexChatHistoryStore::default());
        let stream = futures::stream::iter(vec![
            Ok::<_, std::io::Error>(Bytes::from_static(
                b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\"}}\n\n",
            )),
            Ok(Bytes::from_static(
                b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"{}\",\"reasoning_content\":\"Need a file.\"}}\n\n",
            )),
        ]);

        let output = record_responses_sse_stream(stream, history.clone())
            .collect::<Vec<_>>()
            .await;
        assert_eq!(output.len(), 2);

        let mut request = json!({
            "previous_response_id": "resp_stream",
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "ok"
                }
            ]
        });

        assert_eq!(history.enrich_request(&mut request).await, 1);
        assert_eq!(request["input"][0]["reasoning_content"], "Need a file.");
    }

    #[tokio::test]
    async fn streamed_recorder_preserves_chunks_and_records_exchange_with_request() {
        let history = Arc::new(CodexChatHistoryStore::default());
        let request = json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "Need a streamed tool call."
                        }
                    ]
                }
            ]
        });
        let completed = format!(
            "event: response.completed\ndata: {}\n\n",
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_stream_request",
                    "output": [
                        {
                            "type": "function_call",
                            "call_id": "call_stream_request",
                            "name": "read_file",
                            "arguments": "{}",
                            "reasoning_content": format!("Need {}", '\u{4f60}')
                        }
                    ]
                }
            })
        );
        let split_at = completed
            .as_bytes()
            .windows(3)
            .position(|window| window == "\u{4f60}".as_bytes())
            .expect("test fixture should contain a multibyte character")
            + 1;
        let first = Bytes::copy_from_slice(&completed.as_bytes()[..split_at]);
        let second = Bytes::copy_from_slice(&completed.as_bytes()[split_at..]);
        let expected_chunks = vec![first.clone(), second.clone()];
        let stream = futures::stream::iter(vec![
            Ok::<_, std::io::Error>(first),
            Ok::<_, std::io::Error>(second),
        ]);

        let output = record_responses_sse_stream_with_request(stream, history.clone(), request)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        assert_eq!(output, expected_chunks);

        let mut follow_up = json!({
            "previous_response_id": "resp_stream_request",
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call_stream_request",
                    "output": "ok"
                }
            ]
        });

        assert_eq!(history.enrich_request(&mut follow_up).await, 1);
        let input = follow_up["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "message");
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(
            input[1]["reasoning_content"],
            format!("Need {}", '\u{4f60}')
        );
        assert_eq!(input[2]["type"], "function_call_output");
    }
}
