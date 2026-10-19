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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declaration_changes: Option<OpenAIContractDeclarationChanges>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIContractDeclarationChanges {
    pub added_count: usize,
    pub removed_count: usize,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// Only reviewed public declarations and freshly extracted public documentation
/// enter this projection. Request/provider payloads must never be supplied here.
fn declaration_changes(
    snapshot: &Value,
    current: &Value,
) -> Option<OpenAIContractDeclarationChanges> {
    let declarations = |value: &Value| {
        value
            .get("declarations")?
            .as_array()?
            .iter()
            .map(|value| value.as_str().map(ToString::to_string))
            .collect::<Option<Vec<String>>>()
    };
    let previous = declarations(snapshot)?;
    let next = declarations(current)?;
    fn excess(values: &[String], baseline: &[String]) -> Vec<String> {
        let mut remaining = std::collections::BTreeMap::new();
        for declaration in baseline {
            *remaining.entry(declaration).or_insert(0usize) += 1;
        }
        values
            .iter()
            .filter(|declaration| {
                if let Some(count) = remaining.get_mut(declaration) {
                    if *count > 0 {
                        *count -= 1;
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect()
    }
    let added = excess(&next, &previous);
    let removed = excess(&previous, &next);
    let samples = |values: Vec<String>| {
        values
            .into_iter()
            .take(12)
            .map(|value| {
                if value.chars().count() > 320 {
                    format!(
                        "{} [truncated]",
                        value.chars().take(320).collect::<String>()
                    )
                } else {
                    value
                }
            })
            .collect()
    };
    Some(OpenAIContractDeclarationChanges {
        added_count: added.len(),
        removed_count: removed.len(),
        added: samples(added),
        removed: samples(removed),
    })
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
        declaration_changes: None,
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

fn section_literals(
    body: &str,
    start_line: usize,
    end_line: usize,
    indent: usize,
    expand_enums: bool,
) -> Vec<String> {
    let mut values = Vec::new();
    let mut expanding_type = false;
    for line in body
        .lines()
        .skip(start_line)
        .take(end_line.saturating_sub(start_line))
    {
        let content = line.trim_start_matches(' ');
        let depth = line.len() - content.len();
        let Some(rest) = content.strip_prefix("- `") else {
            continue;
        };
        let Some(end) = rest.find('`') else {
            continue;
        };
        let declaration = &rest[..end];
        if depth <= indent {
            expanding_type = false;
        }
        if depth == indent && declaration.starts_with("type: ") {
            let mut remaining = declaration;
            while let Some(start) = remaining.find('"') {
                let after_start = &remaining[start + 1..];
                let Some(end) = after_start.find('"') else {
                    break;
                };
                values.push(after_start[..end].to_string());
                remaining = &after_start[end + 1..];
            }
            expanding_type = expand_enums
                && declaration
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .windows(3)
                    .any(|words| {
                        words[0] == "or" && words[1].parse::<usize>().is_ok() && words[2] == "more"
                    });
        } else if expanding_type && depth == indent + 2 {
            if let Some(literal) = declaration
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .filter(|value| !value.is_empty() && !value.contains('"'))
            {
                values.push(literal.to_string());
            }
        }
    }
    values.sort();
    values.dedup();
    values
}

fn extract_contract(markdown: &str) -> Result<Value, String> {
    let markdown = markdown.replace("\r\n", "\n");
    let section = markdown
        .split_once("### Body Parameters\n")
        .map(|(_, section)| section)
        .ok_or_else(|| "Official reference body parameters were not found".to_string())?;
    let (body, _) = section.split_once("### Returns").ok_or_else(|| {
        "Official reference is incomplete: Returns boundary is missing".to_string()
    })?;
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
    let (choice_start, choice_end) = section("tool_choice")
        .ok_or_else(|| "Official reference tool choice section is missing".to_string())?;
    let tool_choice_types = section_literals(body, choice_start, choice_end, 4, true);
    if tool_choice_types.is_empty() {
        return Err("Official reference tool choice extraction is incomplete".to_string());
    }

    let declarations = body
        .lines()
        .filter_map(|line| {
            let content = line.trim_start_matches(' ');
            let depth = line.len() - content.len();
            let rest = content.strip_prefix("- `")?;
            let declaration = &rest[..rest.find('`')?];
            Some(format!(
                "{}:{}",
                depth,
                declaration.split_whitespace().collect::<Vec<_>>().join(" ")
            ))
        })
        .collect::<Vec<_>>();
    let mut digest = Sha256::new();
    digest.update(declarations.join("\n"));
    let declarations_sha256 = hex::encode(digest.finalize());

    Ok(json!({
        "declarations_sha256": declarations_sha256,
        "declarations": declarations,
        "top_level_signatures": top_level_signatures_map,
        "input_types": section_literals(body, input_start, input_end, 6, false),
        "tool_types": section_literals(body, tools_start, tools_end, 4, false),
        "tool_choice_types": tool_choice_types,
    }))
}

fn changed_sections(snapshot: &Value, current: &Value) -> Vec<String> {
    [
        ("declarations_sha256", "declarations"),
        ("top_level_signatures", "top-level fields"),
        ("input_types", "input item types"),
        ("tool_types", "tool types"),
        ("tool_choice_types", "tool choice types"),
    ]
    .into_iter()
    .filter(|(key, _)| snapshot.get(key) != current.get(key))
    .map(|(_, label)| label.to_string())
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
    read_reference_response(response).await
}

async fn read_reference_response(mut response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REFERENCE_BYTES as u64)
    {
        return Err("Official reference exceeded the 2 MiB limit".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if chunk.len() > MAX_REFERENCE_BYTES.saturating_sub(bytes.len()) {
            return Err("Official reference exceeded the 2 MiB limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
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
        if snapshot.get("declarations_sha256") != current.get("declarations_sha256") {
            result.declaration_changes = declaration_changes(snapshot, &current);
        }
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
    fn public_declaration_diffs_preserve_counts_and_bound_samples() {
        let diff = declaration_changes(
            &json!({"declarations":["0:shared", "2:repeat", "2:repeat", "4:removed"]}),
            &json!({"declarations":["2:repeat", "0:shared", "6:added", "6:added"]}),
        )
        .unwrap();
        assert_eq!(diff.added_count, 2);
        assert_eq!(diff.removed_count, 2);
        assert_eq!(diff.added, vec!["6:added", "6:added"]);
        assert_eq!(diff.removed, vec!["2:repeat", "4:removed"]);
        let diff = declaration_changes(&json!({"declarations":[]}), &json!({
            "declarations": (0..20).map(|index| format!("4:field{index}: {}", "x".repeat(800))).collect::<Vec<_>>()
        })).unwrap();
        assert_eq!(diff.added_count, 20);
        assert_eq!(diff.added.len(), 12);
        assert!(diff
            .added
            .iter()
            .all(|line| line.chars().count() < 350 && line.ends_with("[truncated]")));
        assert!(declaration_changes(&json!({}), &json!({"declarations":[]})).is_none());
        let serialized = serde_json::to_value(embedded_status()).unwrap();
        assert!(serialized.get("declarationChanges").is_none());
        let serialized = serde_json::to_value(diff).unwrap();
        assert_eq!(serialized["addedCount"], 20);
        assert_eq!(serialized["removedCount"], 0);
    }

    #[test]
    fn truncated_reference_without_returns_fails_closed() {
        let snapshot = embedded_snapshot();
        let body = snapshot["declarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| {
                let (indent, declaration) = value.as_str().unwrap().split_once(':').unwrap();
                format!(
                    "{}- `{declaration}`",
                    " ".repeat(indent.parse::<usize>().unwrap())
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(extract_contract(&format!("### Body Parameters\n{body}")).is_err());
    }

    #[tokio::test]
    async fn reference_limit_is_enforced_before_waiting_for_the_body_to_finish() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
                MAX_REFERENCE_BYTES + 1
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket
                .write_all(&vec![b'x'; MAX_REFERENCE_BYTES + 1])
                .await
                .unwrap();
            socket.write_all(b"\r\n").await.unwrap();
            // Do not terminate the body: a bounded reader must reject it already.
            std::future::pending::<()>().await;
        });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/reference"))
            .send()
            .await
            .unwrap();
        let result =
            tokio::time::timeout(Duration::from_secs(2), read_reference_response(response)).await;
        server.abort();
        assert!(
            matches!(result, Ok(Err(ref error)) if error.contains("2 MiB")),
            "must stop after the size limit without reading EOF: {result:?}"
        );
    }

    #[test]
    fn embedded_status_contains_reviewed_contract_metadata() {
        let status = embedded_status();
        assert_eq!(status.version, 1);
        assert_eq!(status.source, OFFICIAL_SOURCE);
        assert!(!status.declarations_sha256.is_empty());
        assert_eq!(status.status, "not_checked");
    }

    #[test]
    fn reviewed_cli_snapshot_round_trips_through_rust_extraction() {
        let snapshot = embedded_snapshot();
        let declarations = snapshot["declarations"]
            .as_array()
            .expect("reviewed public declaration baseline");
        let body = declarations
            .iter()
            .map(|value| {
                let (indent, declaration) = value
                    .as_str()
                    .expect("public declaration")
                    .split_once(':')
                    .expect("declaration indentation");
                format!(
                    "{}- `{declaration}`",
                    " ".repeat(indent.parse::<usize>().expect("indentation count"))
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let markdown = format!("### Body Parameters\n{body}\n### Returns");
        let current = extract_contract(&markdown).expect("reviewed contract extraction");
        for key in [
            "declarations_sha256",
            "declarations",
            "top_level_signatures",
            "input_types",
            "tool_types",
            "tool_choice_types",
        ] {
            assert_eq!(
                current[key], snapshot[key],
                "{key} differs between extractors"
            );
        }
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
            "- `tool_choice: optional object`",
            "    - `type: \"allowed_tools\"`",
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

    #[test]
    fn retains_declarations_and_expands_only_tool_choice_type_enums() {
        let fields = (0..20)
            .map(|index| format!("- `field{index}: optional string`"))
            .collect::<Vec<_>>()
            .join("\n");
        let markdown = [
            "### Body Parameters",
            fields.as_str(),
            "- `input: optional string or array`",
            "      - `type: \"item_reference\"`",
            "- `tool_choice: optional ToolChoiceTypes or ToolChoiceFunction`",
            "  - `ToolChoiceTypes object { type }`",
            "    - `type: \"file_search\" or \"computer\" or 1 more`",
            "      - `\"file_search\"`",
            "      - `\"computer\"`",
            "      - `\"computer_use\"`",
            "    - `mode: \"auto\" or \"required\"`",
            "      - `\"auto\"`",
            "      - `\"required\"`",
            "  - `ToolChoiceFunction object { name, type }`",
            "    - `name: string`",
            "    - `type: \"function\"`",
            "- `tools: optional array`",
            "    - `type: \"function\"`",
            "    - `type: \"namespace\"`",
            "### Returns",
        ]
        .join("\n");
        let current = extract_contract(&markdown).expect("contract shape");
        assert_eq!(
            current["tool_choice_types"],
            json!(["computer", "computer_use", "file_search", "function"])
        );
        let declarations = current["declarations"]
            .as_array()
            .expect("auditable public declarations");
        assert!(declarations.contains(&json!("6:\"computer_use\"")));
        let normalized = declarations
            .iter()
            .map(|declaration| declaration.as_str().expect("declaration string"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            current["declarations_sha256"],
            hex::encode(Sha256::digest(normalized))
        );
        assert_eq!(
            extract_contract(&markdown.replace('\n', "\r\n")).expect("CRLF reference"),
            current
        );
        assert!(extract_contract(&markdown.replace(
            "- `tool_choice: optional ToolChoiceTypes or ToolChoiceFunction`",
            "- `unrelated: optional object`"
        ))
        .is_err());
    }

    #[test]
    fn reports_tool_choice_union_drift() {
        assert_eq!(
            changed_sections(
                &json!({"tool_choice_types":["function"]}),
                &json!({"tool_choice_types":["function","computer_use"]})
            ),
            vec!["tool choice types"]
        );
    }
}
