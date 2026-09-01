pub mod compiler;
pub mod migration;
pub mod mutation;
pub mod projection;
pub mod schema;

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;

const CODEX_PROVIDER_LABEL_MAX_CHARS: usize = 5;

/// Build a short picker tag without changing the provider's stored identity.
pub(crate) fn compact_codex_provider_label(provider_name: &str) -> String {
    let trimmed = provider_name.trim();
    let alphanumeric = trimmed
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect::<String>();
    if alphanumeric.eq_ignore_ascii_case("openrouter") {
        return "ORter".to_string();
    }
    if alphanumeric.eq_ignore_ascii_case("opencodezen") {
        return "OCzen".to_string();
    }
    if alphanumeric.chars().count() <= CODEX_PROVIDER_LABEL_MAX_CHARS {
        return alphanumeric;
    }

    let mut words = Vec::<String>::new();
    let chars = trimmed.chars().collect::<Vec<_>>();
    let mut current = String::new();
    for (index, character) in chars.iter().copied().enumerate() {
        if !character.is_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        let starts_word = !current.is_empty()
            && character.is_uppercase()
            && index > 0
            && chars[index - 1].is_lowercase();
        if starts_word {
            words.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        words.push(current);
    }

    if words.len() < 2 {
        return alphanumeric
            .chars()
            .take(CODEX_PROVIDER_LABEL_MAX_CHARS)
            .collect();
    }
    if words.len() >= CODEX_PROVIDER_LABEL_MAX_CHARS {
        return words
            .iter()
            .take(CODEX_PROVIDER_LABEL_MAX_CHARS)
            .filter_map(|word| word.chars().next())
            .flat_map(char::to_uppercase)
            .collect();
    }

    let prefix_count = (words.len() - 1).min(CODEX_PROVIDER_LABEL_MAX_CHARS - 1);
    let mut compact = words
        .iter()
        .take(prefix_count)
        .filter_map(|word| word.chars().next())
        .flat_map(char::to_uppercase)
        .collect::<String>();
    let suffix_budget = CODEX_PROVIDER_LABEL_MAX_CHARS.saturating_sub(compact.chars().count());
    let suffix = words
        .last()
        .expect("multiple provider-name words")
        .chars()
        .rev()
        .take(suffix_budget)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    compact.push_str(&suffix);
    compact
}

/// Resolve the Router that owns the single shared Codex live projection.
/// An active workspace wins, followed by the device-local selection and the DB fallback.
pub(crate) fn active_codex_router_id(db: &Database) -> Result<Option<String>, AppError> {
    let local = crate::settings::get_current_provider(&AppType::Codex);
    active_codex_router_id_with_local(db, local.as_deref())
}

pub(crate) fn active_codex_router_id_with_local(
    db: &Database,
    local_provider_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    if let Some(profile_id) = db.get_current_profile_id("codex")? {
        let profiles = db.get_all_profiles()?;
        if let Some(profile) = profiles
            .into_iter()
            .find(|profile| profile.id == profile_id)
        {
            let payload: serde_json::Value =
                serde_json::from_str(&profile.payload).map_err(|error| {
                    AppError::Database(format!("Failed to parse profile payload: {error}"))
                })?;
            if let Some(id) = payload
                .get("providers")
                .and_then(|providers| providers.get("codex"))
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
            {
                if db.get_provider_by_id(id, "codex")?.is_some() {
                    return Ok(Some(id.to_string()));
                }
            }
        }
    }
    if let Some(id) = local_provider_id.filter(|id| !id.is_empty()) {
        if db.get_provider_by_id(id, "codex")?.is_some() {
            return Ok(Some(id.to_string()));
        }
    }
    db.get_current_provider("codex")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Profile;
    use crate::provider::Provider;

    #[test]
    fn provider_picker_labels_are_recognizable_and_never_exceed_five_characters() {
        let cases = [
            ("OpenRouter", "ORter"),
            ("OpenCode Zen", "OCzen"),
            ("DeepSeek", "DSeek"),
            ("Qwen", "Qwen"),
            ("A Very Long Provider Name", "AVLPN"),
        ];
        for (provider, expected) in cases {
            let compact = compact_codex_provider_label(provider);
            assert_eq!(compact, expected, "provider: {provider}");
            assert!(compact.chars().count() <= CODEX_PROVIDER_LABEL_MAX_CHARS);
        }
    }

    #[test]
    fn stale_profile_provider_falls_back_to_device_local_provider() {
        let db = Database::memory().expect("memory db");
        db.save_provider(
            "codex",
            &Provider::with_id(
                "router-local".to_string(),
                "Local Router".to_string(),
                serde_json::json!({}),
                None,
            ),
        )
        .expect("save local router");
        db.save_profile(&Profile {
            id: "workspace".to_string(),
            name: "Workspace".to_string(),
            payload: r#"{"providers":{"codex":"deleted-router"}}"#.to_string(),
            sort_order: None,
            created_at: Some(1),
            updated_at: Some(1),
        })
        .expect("save profile");
        db.set_current_profile_id("codex", Some("workspace"))
            .expect("activate profile");

        assert_eq!(
            active_codex_router_id_with_local(&db, Some("router-local"))
                .expect("resolve active router"),
            Some("router-local".to_string())
        );
    }
}
