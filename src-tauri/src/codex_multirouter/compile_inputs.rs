use crate::codex_config::{official_models_revision, OfficialModelsRevision};
use crate::file_revision::FileRevision;
use crate::proxy::providers::codex_oauth_auth::codex_oauth_store_revision;
use crate::reasoning_capabilities::{
    catalog::{library_revision, LibraryRevision},
    detection_revision,
};
use crate::services::codex_oauth_models::authenticated_model_limits_revision;

/// The compiler combines SQLite routes with evidence owned by these sources.
/// A missing revision means the caller should bypass the compiled-plan cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoutingInputsRevision {
    official_models: OfficialModelsRevision,
    oauth_store: Option<FileRevision>,
    oauth_limits: u64,
    detection: u64,
    library: LibraryRevision,
}

#[cfg(test)]
impl RoutingInputsRevision {
    pub(crate) fn for_test(revision: u64) -> Self {
        Self {
            official_models: OfficialModelsRevision::default(),
            oauth_store: None,
            oauth_limits: 0,
            detection: revision,
            library: LibraryRevision::Unavailable,
        }
    }
}

pub(crate) fn routing_inputs_revision() -> Option<RoutingInputsRevision> {
    Some(RoutingInputsRevision {
        official_models: official_models_revision()?,
        oauth_store: codex_oauth_store_revision()?,
        oauth_limits: authenticated_model_limits_revision()?,
        detection: detection_revision()?,
        library: library_revision()?,
    })
}
