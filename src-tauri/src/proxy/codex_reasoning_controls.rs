//! One request-local wire-control projection for native, converted, and Sub-Agent requests.
//! This is derived state, never a second persisted reasoning authority.

use serde_json::Value;

const CONTROL_PATHS: [&str; 8] = [
    "/reasoning/effort",
    "/reasoning/enabled",
    "/reasoning_effort",
    "/thinking",
    "/enable_thinking",
    "/chat_template_kwargs/enable_thinking",
    "/reasoning_split",
    "/output_config/effort",
];

/// Request-local projection, never persisted. Native controls are captured only
/// after conversion and its safety guards. Later provider body policy may not
/// silently undo canonical reasoning or re-enable guarded-off thinking.
pub(crate) struct CodexReasoningProjection {
    controls: [Option<Value>; CONTROL_PATHS.len()],
}

impl CodexReasoningProjection {
    pub(crate) fn capture(body: &Value) -> Self {
        Self {
            controls: std::array::from_fn(|index| body.pointer(CONTROL_PATHS[index]).cloned()),
        }
    }

    pub(crate) fn apply(&self, body: &mut Value) {
        for (path, value) in CONTROL_PATHS.iter().zip(&self.controls) {
            let segments = path.split('/').skip(1).collect::<Vec<_>>();
            replace_control(body, &segments, value.as_ref());
        }
    }

    pub(crate) fn verify(&self, body: &Value) -> Result<(), super::error::ProxyError> {
        let conflict = self.controls != Self::capture(body).controls;
        let invalid_budget = body
            .pointer("/thinking/budget_tokens")
            .and_then(Value::as_u64)
            .is_some_and(|budget| {
                body.get("max_tokens")
                    .and_then(Value::as_u64)
                    .is_none_or(|ceiling| budget < 1024 || budget > ceiling / 2)
            });
        if conflict || invalid_budget {
            return Err(super::error::ProxyError::ConfigError(
                "Canonical Codex reasoning conflicts with provider request-body settings; remove conflicting reasoning/thinking or output-budget overrides, or select Profile settings for the Sub-Agent plan".to_string(),
            ));
        }
        Ok(())
    }
}

fn replace_control(body: &mut Value, path: &[&str], replacement: Option<&Value>) {
    let Some((key, rest)) = path.split_first() else {
        return;
    };
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if rest.is_empty() {
        if let Some(value) = replacement {
            object.insert((*key).to_string(), value.clone());
        } else {
            object.remove(*key);
        }
        return;
    }
    if replacement.is_some() {
        let child = object
            .entry((*key).to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !child.is_object() {
            *child = serde_json::json!({});
        }
        replace_control(child, rest, replacement);
    } else if let Some(child) = object.get_mut(*key) {
        replace_control(child, rest, None);
        if child.as_object().is_some_and(|child| child.is_empty()) {
            object.remove(*key);
        }
    }
}
