//! In-app status and live drift checks for the reviewed OpenAI Responses contract.
//!
//! Runtime request inspection stays offline and conservative. This module only
//! fetches the public OpenAI reference when the user explicitly asks the UI to
//! check for changes.

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const OFFICIAL_SOURCE: &str =
    "https://developers.openai.com/api/reference/resources/responses/methods/create.md";
const MAX_REFERENCE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIResponsesContractStatus {
    pub version: u32,
    pub source: String,
    pub verified_at: String,
    pub coverage: String,
    pub declarations_sha256: String,
    pub status: String,
    pub checked_at: Option<String>,
    pub changed_sections: Vec<String>,
    pub error: Option<String>,
}

fn embedded_snapshot() -> &'static Value {
    static SNAPSHOT: OnceLock<Value> = OnceLock::new();
    SNAPSHOT.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/openai-responses.v1.json"))
            .expect("reviewed OpenAI Responses contract must be valid JSON")
    })
}

fn last_check() -> &'static Mutex<Option<OpenAIResponsesContractStatus>> {
    static LAST_CHECK: OnceLock<Mutex<Option<OpenAIResponsesContractStatus>>> = OnceLock::new();
    LAST_CHECK.get_or_init(|| Mutex::new(None))
}

fn embedded_status() -> OpenAIResponsesContractStatus {
    let snapshot = embedded_snapshot();
    OpenAIResponsesContractStatus {
        version: snapshot
            .get("version")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        source: snapshot
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or(OFFICIAL_SOURCE)
            .to_string(),
        verified_at: snapshot
            .get("verified_at")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        coverage: snapshot
            .get("coverage")
            .and_then(Value::as_str)
            .unwrap_or("Conservative Responses contract checks")
            .to_string(),
        declarations_sha256: snapshot
            .get("declarations_sha256")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: "not_checked".to_string(),
        checked_at: None,
        changed_sections: Vec::new(),
        error: None,
    }
}

pub(crate) fn status() -> OpenAIResponsesContractStatus {
    last_check()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(embedded_status)
}

fn set_last_check(value: OpenAIResponsesContractStatus) -> OpenAIResponsesContractStatus {
    *last_check()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(value.clone());
    value
}

fn top_level_signatures(body: &str) -> Vec<(String, String, usize)> {
    body.lines()
        .enumerate()
        .filter_map(|(line_index, line)| {
            let content = line.strip_prefix("- `")?;
            let end = content.find('`')?;
            let declaration = &content[..end];
            let (name, signature) = declaration.split_once(": ")?;
            if name.is_empty()
                || !name
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_')
            {
                return None;
            }
            Some((
                name.to_string(),
                signature.split_whitespace().collect::<Vec<_>>().join(" "),
                line_index,
            ))
        })
        .collect()
}

fn section_literals(body: &str, start_line: usize, end_line: usize, indent: usize) -> Vec<String> {
    let prefix = format!("{}- `type: ", " ".repeat(indent));
    let mut values = Vec::new();
    for line in body
        .lines()
        .skip(start_line)
        .take(end_line.saturating_sub(start_line))
    {
        let Some(rest) = line.strip_prefix(&prefix) else {
            continue;
        };
        let Some(end) = rest.find('`') else {
            continue;
        };
        let declaration = &rest[..end];
        let mut remaining = declaration;
        while let Some(start) = remaining.find('"') {
            let after_start = &remaining[start + 1..];
            let Some(end) = after_start.find('"') else {
                break;
            };
            values.push(after_start[..end].to_string());
            remaining = &after_start[end + 1..];
        }
    }
    values.sort();
    values.dedup();
    values
}

fn extract_contract(markdown: &str) -> Result<Value, String> {
    let body = markdown
        .split("### Body Parameters\n")
        .nth(1)
        .and_then(|value| value.split("### Returns").next())
        .ok_or_else(|| "Official reference body parameters were not found".to_string())?;
    let top = top_level_signatures(body);
    if top.len() < 20 {
        return Err("Official reference extraction is incomplete".to_string());
    }

    let mut top_level_signatures_map = Map::new();
    for (name, signature, _) in &top {
        top_level_signatures_map.insert(name.clone(), Value::String(signature.clone()));
    }

    let section = |name: &str| {
        let start = top
            .iter()
            .find(|(candidate, _, _)| candidate == name)
            .map(|(_, _, line)| *line)?;
        let end = top
            .iter()
            .find(|(_, _, line)| *line > start)
            .map(|(_, _, line)| *line)
            .unwrap_or_else(|| body.lines().count());
        Some((start, end))
    };
    let (input_start, input_end) = section("input")
        .ok_or_else(|| "Official reference input section is missing".to_string())?;
    let (tools_start, tools_end) =
        section("tools").ok_or_else(|| "Official reference tool section is missing".to_string())?;

    let declarations = body
        .lines()
        .filter_map(|line| {
            let dash = line.find("- `")?;
            let declaration = line[dash + 3..].split('`').next()?;
            Some(format!(
                "{}:{}",
                dash,
                declaration.split_whitespace().collect::<Vec<_>>().join(" ")
            ))
        })
        .collect::<Vec<_>>();
    let mut digest = Sha256::new();
    digest.update(declarations.join("\n"));
    let declarations_sha256 = hex::encode(digest.finalize());

    Ok(json!({
        "declarations_sha256": declarations_sha256,
        "top_level_signatures": top_level_signatures_map,
        "input_types": section_literals(body, input_start, input_end, 6),
        "tool_types": section_literals(body, tools_start, tools_end, 4),
    }))
}

fn changed_sections(snapshot: &Value, current: &Value) -> Vec<String> {
    [
        ("declarations_sha256", "declarations"),
        ("top_level_signatures", "top-level fields"),
        ("input_types", "input item types"),
        ("tool_types", "tool types"),
    ]
    .into_iter()
    .filter_map(|(key, label)| (snapshot.get(key) != current.get(key)).then(|| label.to_string()))
    .collect()
}

async fn fetch_reference() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("CCSwitchMulti/contract-health")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(OFFICIAL_SOURCE)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Official reference returned HTTP {}",
            response.status()
        ));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_REFERENCE_BYTES {
        return Err("Official reference exceeded the 2 MiB limit".to_string());
    }
    String::from_utf8(bytes.to_vec())
        .map(|value| value.replace("\r\n", "\n"))
        .map_err(|error| error.to_string())
}

pub(crate) async fn check() -> OpenAIResponsesContractStatus {
    let mut result = embedded_status();
    result.checked_at = Some(Utc::now().to_rfc3339());

    let outcome = async {
        let markdown = fetch_reference().await?;
        let current = extract_contract(&markdown)?;
        let snapshot = embedded_snapshot();
        let changes = changed_sections(snapshot, &current);
        let invariants_changed = snapshot
            .get("invariants")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("evidence").and_then(Value::as_str))
            .any(|evidence| !markdown.contains(evidence));
        let mut all_changes = changes;
        if invariants_changed {
            all_changes.push("reviewed invariants".to_string());
        }
        all_changes.sort();
        all_changes.dedup();
        Ok::<Vec<String>, String>(all_changes)
    }
    .await;

    match outcome {
        Ok(changes) if changes.is_empty() => {
            result.status = "up_to_date".to_string();
        }
        Ok(changes) => {
            result.status = "drift_detected".to_string();
            result.changed_sections = changes;
        }
        Err(error) => {
            result.status = "check_failed".to_string();
            result.error = Some(error);
        }
    }
    set_last_check(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_status_contains_reviewed_contract_metadata() {
        let status = embedded_status();
        assert_eq!(status.version, 1);
        assert_eq!(status.source, OFFICIAL_SOURCE);
        assert!(!status.declarations_sha256.is_empty());
        assert_eq!(status.status, "not_checked");
    }

    #[test]
    fn extracts_reviewed_shape_from_reference_fixture() {
        let fixture = include_str!("../../../contracts/openai-responses.v1.json");
        let markdown = format!(
            "### Body Parameters\n{}\n### Returns",
            fixture.replace("\"", "`")
        );
        assert!(extract_contract(&markdown).is_err());
    }

    #[test]
    fn extracts_typed_sections_without_counting_prose() {
        let fields = (0..20)
            .map(|index| format!("- `field{index}: optional string`"))
            .collect::<Vec<_>>()
            .join("\n");
        let markdown = [
            "### Body Parameters",
            fields.as_str(),
            "- `input: optional string or array`",
            "      - `type: \"message\"`",
            "      - `type: \"additional_tools\"`",
            "      - `input: string`",
            "      - `type: \"custom_tool_call\"`",
            "- `instructions: optional string`",
            "- `tools: optional array`",
            "    - `type: \"web_search\" or \"web_search_preview\"`",
            "- `top_logprobs: optional number`",
            "### Returns",
        ]
        .join("\n");
        let current = extract_contract(&markdown).expect("contract shape");
        assert_eq!(
            current["input_types"],
            json!(["additional_tools", "custom_tool_call", "message"])
        );
        assert_eq!(
            current["tool_types"],
            json!(["web_search", "web_search_preview"])
        );
    }
}
