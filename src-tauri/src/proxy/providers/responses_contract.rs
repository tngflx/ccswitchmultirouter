//! Conservative, offline final-wire checks. Never retain request values.
//! Unknown extensions are informational; this is not a model capability oracle.

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Contract {
    version: u32,
    field_types: BTreeMap<String, Vec<String>>,
    input_types: Vec<String>,
    tool_types: Vec<String>,
    tool_choice_types: Vec<String>,
}

fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../contracts/openai-responses.v1.json"
        ))
        .expect("reviewed Responses contract must be valid")
    })
}

pub(crate) struct ContractFinding {
    pub code: &'static str,
    pub severity: &'static str,
    pub count: usize,
    pub detail: String,
}

#[derive(Default)]
struct Checks {
    findings: BTreeMap<&'static str, ContractFinding>,
    type_paths: Vec<String>,
}

impl Checks {
    fn finding(&mut self, code: &'static str, severity: &'static str, detail: &str) {
        self.findings
            .entry(code)
            .or_insert_with(|| ContractFinding {
                code,
                severity,
                count: 0,
                detail: detail.to_string(),
            })
            .count += 1;
    }

    fn typed(&mut self, value: Option<&Value>, types: &[&str], required: bool, path: &str) {
        let valid = match value {
            None => !required,
            Some(value) => types.contains(&json_type(value)),
        };
        if !valid {
            self.finding(
                "responses_field_type",
                "error",
                "Known Responses field types do not match the reviewed contract",
            );
            if self.type_paths.len() < 12 {
                self.type_paths.push(path.to_string());
            }
        }
    }

    fn unknown(&mut self) {
        self.finding(
            "responses_unverified_extension",
            "info",
            "Fields or item/tool kinds outside the reviewed Responses contract were passed through unchanged; provider acceptance is unverified",
        );
    }

    fn finish(mut self) -> Vec<ContractFinding> {
        if let Some(finding) = self.findings.get_mut("responses_field_type") {
            finding.detail = format!(
                "Contract v{}: wrong or missing field types at {}{}; values are redacted",
                contract().version,
                self.type_paths.join(", "),
                if finding.count > self.type_paths.len() {
                    " (additional paths omitted)"
                } else {
                    ""
                }
            );
        }
        self.findings.into_values().collect()
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(crate) fn uses_server_history(body: &Value) -> bool {
    ["previous_response_id", "conversation"]
        .iter()
        .any(|key| body.get(key).is_some_and(|value| !value.is_null()))
}

/// Caller selects the actual wire transport, not the incoming logical endpoint.
/// Hosted-search history is a backend-specific invariant, separately gated.
pub(crate) fn inspect(body: &Value, check_search_history: bool) -> Vec<ContractFinding> {
    let mut checks = Checks::default();
    let Some(object) = body.as_object() else {
        checks.typed(Some(body), &["object"], true, "$");
        return checks.finish();
    };
    for (key, value) in object {
        if let Some(types) = contract().field_types.get(key) {
            let types = types.iter().map(String::as_str).collect::<Vec<_>>();
            checks.typed(Some(value), &types, false, key);
        } else {
            checks.unknown();
        }
    }
    if body.get("conversation").is_some_and(|v| !v.is_null())
        && body
            .get("previous_response_id")
            .is_some_and(|v| !v.is_null())
    {
        checks.finding(
            "conversation_previous_response_conflict",
            "error",
            "conversation and previous_response_id cannot both be supplied to Responses create",
        );
    }
    for (parent, key, types) in [
        ("reasoning", "effort", &["string", "null"][..]),
        ("reasoning", "summary", &["string", "null"][..]),
        ("stream_options", "include_obfuscation", &["boolean"][..]),
        ("text", "format", &["object"][..]),
    ] {
        if let Some(value) = body.get(parent).and_then(|v| v.get(key)) {
            checks.typed(Some(value), types, false, &format!("{parent}.{key}"));
        }
    }

    let mut tools = Vec::new();
    if let Some(declared) = body.get("tools").and_then(Value::as_array) {
        inspect_tools(declared, "tools", 0, &mut tools, &mut checks);
    }
    if let Some(items) = body.get("input").and_then(Value::as_array) {
        for (index, item) in items.iter().enumerate() {
            let path = format!("input[{index}]");
            if !item.is_object() {
                checks.typed(Some(item), &["object"], true, &path);
                continue;
            }
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            let inferred_reference = matches!(item.get("type"), None | Some(Value::Null))
                && item.get("id").is_some()
                && item.as_object().is_some_and(|object| {
                    object
                        .keys()
                        .all(|key| matches!(key.as_str(), "id" | "type"))
                });
            if let Some(value) = item.get("type") {
                checks.typed(
                    Some(value),
                    if inferred_reference {
                        &["string", "null"]
                    } else {
                        &["string"]
                    },
                    true,
                    &format!("{path}.type"),
                );
            }
            if inferred_reference || kind == "item_reference" {
                checks.typed(item.get("id"), &["string"], true, &format!("{path}.id"));
            }
            if !kind.is_empty() && !contract().input_types.iter().any(|t| t == kind) {
                checks.unknown();
            }
            match kind {
                "compaction_trigger" if index + 1 != items.len() => checks.finding(
                    "compaction_trigger_not_last",
                    "error",
                    "A compaction_trigger must be the final input item",
                ),
                "additional_tools" => {
                    if item.get("role").and_then(Value::as_str) != Some("developer") {
                        checks.finding(
                            "additional_tools_role",
                            "error",
                            "additional_tools requires role developer",
                        );
                    }
                    checks.typed(
                        item.get("tools"),
                        &["array"],
                        true,
                        &format!("{path}.tools"),
                    );
                    if let Some(declared) = item.get("tools").and_then(Value::as_array) {
                        inspect_tools(
                            declared,
                            &format!("{path}.tools"),
                            0,
                            &mut tools,
                            &mut checks,
                        );
                    }
                }
                "function_call" | "custom_tool_call" => {
                    for field in ["call_id", "name"] {
                        checks.typed(
                            item.get(field),
                            &["string"],
                            true,
                            &format!("{path}.{field}"),
                        );
                    }
                    let field = if kind == "function_call" {
                        "arguments"
                    } else {
                        "input"
                    };
                    checks.typed(
                        item.get(field),
                        &["string"],
                        true,
                        &format!("{path}.{field}"),
                    );
                }
                "function_call_output" | "custom_tool_call_output" => {
                    checks.typed(
                        item.get("output"),
                        &["string", "array"],
                        true,
                        &format!("{path}.output"),
                    );
                    // Function output call_id is optional in the public reference.
                    checks.typed(
                        item.get("call_id"),
                        if kind == "function_call_output" {
                            &["string", "null"]
                        } else {
                            &["string"]
                        },
                        kind == "custom_tool_call_output",
                        &format!("{path}.call_id"),
                    );
                }
                "message" | "" if kind == "message" || item.get("role").is_some() => {
                    checks.typed(item.get("role"), &["string"], true, &format!("{path}.role"));
                    checks.typed(
                        item.get("content"),
                        &["string", "array"],
                        true,
                        &format!("{path}.content"),
                    );
                }
                _ => {}
            }
        }
    }
    inspect_choice(body.get("tool_choice"), &tools, &mut checks, 0);
    if check_search_history {
        let count = super::codex_web_search_history::undeclared_web_search_history_count(body);
        for _ in 0..count {
            checks.finding(
                "undeclared_web_search_history",
                "error",
                "Hosted search history has no matching web_search declaration in the final request",
            );
        }
    }
    checks.finish()
}

fn inspect_tools<'a>(
    declared: &'a [Value],
    path: &str,
    depth: usize,
    tools: &mut Vec<&'a Value>,
    checks: &mut Checks,
) {
    if depth >= 8 {
        checks.unknown();
        return;
    }
    for (index, tool) in declared.iter().enumerate() {
        let path = format!("{path}[{index}]");
        checks.typed(Some(tool), &["object"], true, &path);
        if !tool.is_object() {
            continue;
        }
        checks.typed(tool.get("type"), &["string"], true, &format!("{path}.type"));
        let kind = tool.get("type").and_then(Value::as_str).unwrap_or("");
        if !kind.is_empty() && !contract().tool_types.iter().any(|t| t == kind) {
            checks.unknown();
        }
        if matches!(kind, "function" | "custom" | "namespace") {
            checks.typed(tool.get("name"), &["string"], true, &format!("{path}.name"));
        }
        if kind == "function" {
            checks.typed(
                tool.get("strict"),
                &["boolean", "null"],
                false,
                &format!("{path}.strict"),
            );
        }
        if kind == "namespace" {
            checks.typed(
                tool.get("tools"),
                &["array"],
                true,
                &format!("{path}.tools"),
            );
            if let Some(nested) = tool.get("tools").and_then(Value::as_array) {
                inspect_tools(nested, &format!("{path}.tools"), depth + 1, tools, checks);
            }
        }
        tools.push(tool);
    }
}

fn inspect_choice(choice: Option<&Value>, tools: &[&Value], checks: &mut Checks, depth: usize) {
    if depth >= 8 {
        checks.unknown();
        return;
    }
    let Some(choice) = choice.filter(|v| !v.is_null()) else {
        return;
    };
    if let Some(mode) = choice.as_str() {
        if mode == "required" && tools.is_empty() {
            checks.finding(
                "tool_choice_without_tools",
                "error",
                "Required tool choice has no declared tools",
            );
        } else if !matches!(mode, "none" | "auto" | "required") {
            checks.unknown();
        }
        return;
    }
    if !choice.is_object() {
        return;
    }
    checks.typed(choice.get("type"), &["string"], true, "tool_choice.type");
    let kind = choice.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "allowed_tools" {
        checks.typed(choice.get("mode"), &["string"], true, "tool_choice.mode");
        checks.typed(choice.get("tools"), &["array"], true, "tool_choice.tools");
        if let Some(allowed) = choice.get("tools").and_then(Value::as_array) {
            for item in allowed {
                inspect_choice(Some(item), tools, checks, depth + 1);
            }
        }
        return;
    }
    // The create reference retains preview search choices; the search guide
    // also permits a specific modern web-search choice.
    if !contract().tool_choice_types.iter().any(|t| t == kind)
        && !matches!(kind, "web_search" | "web_search_2025_08_26")
    {
        checks.unknown();
        return;
    }
    if matches!(kind, "function" | "custom") {
        checks.typed(choice.get("name"), &["string"], true, "tool_choice.name");
    }
    let matches = tools.iter().any(|tool| {
        let declared_kind = tool.get("type").and_then(Value::as_str).unwrap_or("");
        (kind == declared_kind
            || (kind.starts_with("web_search") && declared_kind.starts_with("web_search"))
            || (matches!(kind, "computer" | "computer_use" | "computer_use_preview")
                && matches!(
                    declared_kind,
                    "computer" | "computer_use" | "computer_use_preview"
                )))
            && (!matches!(kind, "function" | "custom") || choice.get("name") == tool.get("name"))
            && (kind != "mcp" || choice.get("server_label") == tool.get("server_label"))
    });
    if !matches {
        checks.finding(
            "undeclared_tool_choice",
            // Dynamic tool search and namespaces can supply declarations later.
            if tools.iter().any(|tool| {
                matches!(
                    tool.get("type").and_then(Value::as_str),
                    Some("tool_search" | "namespace")
                )
            }) {
                "warning"
            } else {
                "error"
            },
            "An explicit tool choice has no matching declaration in tools or additional_tools",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codes(body: Value) -> Vec<&'static str> {
        inspect(&body, true)
            .iter()
            .map(|finding| finding.code)
            .collect()
    }

    #[test]
    fn accepts_optional_nulls_prompt_only_and_current_documented_extensions() {
        for body in [
            json!({}),
            json!({"prompt":{"id":"fixture"}}),
            json!({"input":"text","stream":null,"reasoning":null,"tools":null,"tool_choice":null}),
            json!({"input":[
                {"type":"additional_tools","role":"developer","tools":[{"type":"web_search"}]},
                {"type":"web_search_call"},
                {"type":"compaction_trigger"}
            ],"tool_choice":"none"}),
            json!({"input":[{"id":"server-item"},{"type":"function_call_output","output":[]}]}),
        ] {
            assert!(codes(body).is_empty());
        }
    }

    #[test]
    fn known_field_types_are_redacted_and_bounded() {
        let body = json!({"model":42,"stream":"private","reasoning":{"effort":42},
            "input":[{"type":"function_call","call_id":"private","name":"private","arguments":{"secret":true}}]});
        let findings = inspect(&body, true);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].count, 4);
        assert!(findings[0].detail.contains("input[0].arguments"));
        assert!(!findings[0].detail.contains("private"));
        assert!(!findings[0].detail.contains("secret"));
        let body = json!({"input":vec![Value::Bool(false); 1000]});
        let findings = inspect(&body, true);
        assert_eq!(findings[0].count, 1000);
        assert!(findings[0].detail.len() < 400);
    }

    #[test]
    fn checks_replay_invariants_without_mutation() {
        let body = json!({"conversation":"private","previous_response_id":"private",
            "input":[{"type":"compaction_trigger"},{"type":"additional_tools","role":"user","tools":[]},
            {"type":"web_search_call"}]});
        let original = body.clone();
        assert_eq!(
            codes(body.clone()),
            vec![
                "additional_tools_role",
                "compaction_trigger_not_last",
                "conversation_previous_response_conflict",
                "undeclared_web_search_history"
            ]
        );
        assert_eq!(body, original);
        assert!(uses_server_history(&json!({"previous_response_id":"id"})));
        assert!(!uses_server_history(&json!({"conversation":null})));
        assert!(!inspect(&body, false)
            .iter()
            .any(|f| f.code == "undeclared_web_search_history"));
    }

    #[test]
    fn checks_explicit_tool_choices_and_reuses_lite_declarations() {
        assert_eq!(
            codes(json!({"tools":[],"tool_choice":"required"})),
            vec!["tool_choice_without_tools"]
        );
        assert_eq!(
            codes(json!({"tools":[{"type":"function","name":"a"}],
            "tool_choice":{"type":"function","name":"b"}})),
            vec!["undeclared_tool_choice"]
        );
        assert!(codes(json!({"input":[{"type":"additional_tools","role":"developer",
            "tools":[{"type":"function","name":"a"}]}],"tool_choice":{"type":"function","name":"a"}})).is_empty());
        assert!(codes(json!({"tools":[{"type":"web_search_preview"}],
            "tool_choice":{"type":"web_search"}}))
        .is_empty());
        assert!(codes(json!({"tools":[{"type":"namespace","name":"n","tools":[{"type":"function","name":"a"}]}],
            "tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"function","name":"a"}]}})).is_empty());
    }

    #[test]
    fn unknown_extensions_pass_through_and_are_never_echoed() {
        let body = json!({"private_key":true,"input":[{"type":"private_kind"}],
            "tools":[{"type":"private_tool"}],"tool_choice":{"type":"future_choice"}});
        let findings = inspect(&body, true);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].count, 4);
        assert_eq!(findings[0].severity, "info");
        assert!(!findings[0].detail.contains("private"));
    }

    #[test]
    fn accepts_nullable_item_references_without_weakening_other_item_types() {
        for item in [
            json!({"id":"server-item"}),
            json!({"id":"server-item","type":null}),
            json!({"id":"server-item","type":"item_reference"}),
        ] {
            assert!(codes(json!({"input":[item]})).is_empty());
        }
        for item in [
            json!({"id":false,"type":null}),
            json!({"type":"item_reference"}),
            json!({"id":"server-item","type":null,"role":"user","content":"text"}),
            json!({"id":"server-item","type":null,"call_id":"call","name":"tool","arguments":"{}"}),
        ] {
            assert_eq!(codes(json!({"input":[item]})), vec!["responses_field_type"]);
        }
    }

    #[test]
    fn tool_choices_use_their_own_union_and_computer_aliases() {
        for (choice, declared) in [
            ("computer", "computer"),
            ("computer_use", "computer"),
            ("computer_use_preview", "computer_use_preview"),
            ("web_search", "web_search"),
            ("web_search", "web_search_preview"),
            ("web_search_preview_2025_03_11", "web_search_2025_08_26"),
        ] {
            assert!(
                codes(json!({
                    "tools":[{"type":declared}],
                    "tool_choice":{"type":choice}
                }))
                .is_empty(),
                "{choice} must match its {declared} declaration"
            );
        }
        assert_eq!(
            codes(json!({"tool_choice":{"type":"computer_use"}})),
            vec!["undeclared_tool_choice"]
        );
        for kind in ["namespace", "tool_search", "local_shell"] {
            let findings = inspect(
                &json!({
                    "tools":[{"type":kind,"name":"fixture","tools":[]}],
                    "tool_choice":{"type":kind}
                }),
                false,
            );
            assert_eq!(findings.len(), 1);
            assert_eq!(findings[0].code, "responses_unverified_extension");
            assert_eq!(findings[0].severity, "info");
        }
    }
}
