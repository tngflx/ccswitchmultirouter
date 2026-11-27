import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
export const MAX_FAILURE_EVIDENCE_ITEMS = 8;
export const PERFORMANCE_TEST_FILTERS = Object.freeze([
  "cold_and_unchanged_rollout_work_is_bounded_by_required_bytes",
  "retryable_child_snapshot_reuse_bounds_parsing_and_retained_records",
  "retryable_parent_timeline_checks_exact_bytes_without_reparsing_unchanged_history",
  "parent_timeline_cache_retention_bounds_real_lookup_work",
  "parent_timeline_cache_admission_counts_capacity_and_allocations_separately",
  "oversized_parent_timeline_returns_all_signatures_without_retaining_history",
  "missing_history_base_page_skips_appended_tail_and_recovers_same_stamp_rewrite",
  "initial_sync_retries_in_place_middle_rewrite_with_restored_mtime",
  "unchanged_child_missing_copied_parent_prefix_skips_tail_and_recovers_same_stamp_rewrite",
  "copied_parent_comparison_streams_one_child_token_ahead",
  "rejected_prefix_rechecks_bounded_bytes_across_appends_and_rejects_changed_content",
  "diagnostics_and_forwarding_serialize_each_body_variant_once",
  "bodyless_methods_skip_active_diagnostics_and_serialization",
  "finalized_request_shares_uncompressed_bytes_and_hashes_each_wire_variant_once",
  "provider_attempt_body_borrows_history_and_isolates_bedrock_on_failover",
  "disabled_diagnostics_skip_serialization_item_analysis_and_optimization",
  "diagnostic_sizes_share_the_emitted_json_traversal",
  "only_winning_messages_provider_reads_original_responses_history_input",
  "journal_scan_work_is_independent_of_fragment_count",
  "journal_searches_each_fragment_once_and_recovers_after_an_oversized_frame",
  "bounded_sse_frames_scan_each_wire_byte_once_across_fragment_sizes",
  "text_sse_frames_scan_each_wire_byte_once_across_fragment_sizes",
  "complete_sse_blocks_scan_each_frame_once",
  "partial_custom_input_decoder_scans_appended_bytes_once",
  "repeated_call_updates_size_only_new_items",
  "repeated_deferred_polls_parse_only_through_first_unsettled_turn",
  "rich_descriptor_join_scans_each_descriptor_and_alias_matched_row_once",
  "native_sse_payload_is_parsed_once_with_legacy_field_precedence",
  "native_responses_fragmented_frames_share_one_payload_parse",
  "responses_stream_priming_fragmented_work_is_linear",
  "responses_stream_priming_many_lifecycle_frames_are_inspected_once",
  "responses_stream_priming_wrapper_work_is_linear",
  "native_usage_scan_cadence_skips_unchanged_sources_until_due",
  "repeated_incomplete_usage_scans_keep_the_normal_work_bound",
  "native_usage_sources_keep_shared_target_ids_and_dedupe_websocket_aliases",
  "rollout_effort_skips_json_parsing_for_replayed_tool_outputs",
  "sublyx_maintained_gpt_parent_ultra_and_subagents_follow_saved_policy_across_transports",
  "incremental_sync_hashes_committed_prefix_once_on_append",
  "incremental_sync_rejects_middle_rewrites_without_reparsing_committed_prefix",
  "upstream_4_paginated_shared_predecessor_reuses_parse_and_checks_same_stamp_edits",
  "upstream_session_cursor_unchanged_incomplete_tail_does_no_content_work",
  "gemini_usage_unchanged_snapshots_do_not_replay_json",
  "opencode_usage_unchanged_sessions_do_not_replay_json",
  "session_listing_reuses_rollouts_and_index_across_refreshes",
  "session_listing_reloads_titles_for_wal_commits_without_reparsing_rollouts",
  "session_listing_reuses_rollback_titles_until_database_changes",
  "listing_skips_unchanged_invalid_gemini_histories_and_recovers_on_rewrite",
  "listing_reuses_unchanged_histories_and_reloads_revisions",
  "session_listing_reuses_unchanged_files_and_reloads_changed_revision",
  "listing_reuses_unchanged_files_and_reloads_changed_revisions",
  "scan_sessions_json_reloads_replacements_and_malformed_files",
  "scan_sessions_json_reuses_unchanged_message_summary",
  "scan_sessions_sqlite_reloads_wal_snapshots",
  "scan_sessions_sqlite_reuses_unchanged_rollback_revision",
  "jsonl_listing_reuses_unchanged_metadata_and_reloads_revisions",
  "sqlite_listing_reuses_unchanged_rollback_snapshot",
  "raw_request_body_collection_rejects_bytes_over_limit",
  "compressed_request_body_rejects_expansion_over_limit",
  "anthropic_aggregation_appends_fragments_once_and_releases_tool_buffers",
  "messages_stream_reuses_accepted_payloads_across_capacity_replay",
  "hosted_web_search_deferred_events_stop_at_the_encoded_byte_budget",
  "hosted_web_search_pending_sources_share_budget_and_preserve_first_seen_order",
  "hosted_web_search_citation_keys_stop_at_the_byte_budget_without_text",
  "cache_prunes_by_retained_bytes_without_flushing_on_oversized_updates",
  "xai_request_model_only_visits_catalog_for_unmatched_models",
  "router_log_queue_bounds_pending_work_and_preserves_order",
  "router_log_queue_bounds_entry_size_before_and_after_redaction",
  "failover_reads_only_queued_provider_rows_in_queue_order",
  "cold_compile_indexes_catalog_once_for_shared_routes",
  "codex_router_cache_reuses_compiled_plan_for_small_and_large_text_and_raw_requests",
  "codex_router_cache_compiles_one_plan_for_concurrent_cold_requests",
  "codex_router_cache_invalidates_after_catalog_edit_and_deletion",
  "codex_router_cache_invalidates_after_external_catalog_commit",
  "codex_router_cache_invalidates_after_router_plan_and_external_input_changes",
  "codex_router_cache_retries_when_sqlite_or_external_revision_changes_during_compile",
  "codex_images_text_and_external_models_share_the_sqlite_route_plan",
  "external_provider_model_listing_indexes_the_canonical_catalog_once",
  "repeated_library_reads_share_the_loaded_registry",
  "official_model_snapshot_reuses_one_merge_per_revision_and_respects_ownership",
  "long_recovery_leases_share_durable_checkpoints_inside_the_startup_ttl",
  "recovery_polling_reuses_provider_digest_until_sqlite_revision_changes",
  "model_list_byte_budget_stops_polling_at_first_oversized_chunk",
  "model_list_page_byte_and_row_budgets_are_shared_and_fail_closed",
  "models_dev_indexes_small_and_large_catalogs_in_one_pass",
  "models_dev_cache_reuses_the_index_and_revalidates_expired_facts",
  "zhipu_detail_enrichment_caps_fast_requests_and_preserves_admitted_aliases",
]);
export const CARGO_TEST_ARGS = Object.freeze([
  "test",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--lib",
  "--jobs",
  "2",
  "--",
  ...PERFORMANCE_TEST_FILTERS,
  "--test-threads=2",
  "--format=pretty",
  "--color=never",
]);

function verificationError(message, { cause, status } = {}) {
  const error = new Error(message, { cause });
  error.exitCode =
    Number.isInteger(status) && status > 0 && status <= 255 ? status : 1;
  return error;
}

export function collectResourceFailureEvidence(result) {
  const failedTests = new Set();
  const compilerErrorCodes = new Set();
  for (const output of [result.stdout, result.stderr]) {
    if (typeof output !== "string") continue;
    for (const line of output.split(/\r?\n/)) {
      const failed =
        /^test ([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*) \.\.\. FAILED$/.exec(
          line,
        );
      if (failed) {
        const expected = PERFORMANCE_TEST_FILTERS.find(
          (name) => failed[1] === name || failed[1].endsWith("::" + name),
        );
        // Emit only canonical names from the fixed suite, never arbitrary log text.
        if (expected) failedTests.add(expected);
      }
      const diagnostic = /^error\[(E[0-9]{4})\]:/.exec(line);
      if (diagnostic) compilerErrorCodes.add(diagnostic[1]);
    }
  }
  return Object.freeze({
    failedTests: Object.freeze(
      [...failedTests].slice(0, MAX_FAILURE_EVIDENCE_ITEMS),
    ),
    compilerErrorCodes: Object.freeze(
      [...compilerErrorCodes].slice(0, MAX_FAILURE_EVIDENCE_ITEMS),
    ),
    omittedFailedTests: Math.max(
      0,
      failedTests.size - MAX_FAILURE_EVIDENCE_ITEMS,
    ),
    omittedCompilerErrorCodes: Math.max(
      0,
      compilerErrorCodes.size - MAX_FAILURE_EVIDENCE_ITEMS,
    ),
  });
}

function cargoFailure(message, result, cause = result.error) {
  const evidence = collectResourceFailureEvidence(result);
  const selected = evidence.failedTests[0] ?? PERFORMANCE_TEST_FILTERS[0];
  const lines = [
    message,
    "Command context: cargo test --manifest-path src-tauri/Cargo.toml --lib --jobs 2 with the fixed resource regression filters, --test-threads=2 --format=pretty --color=never.",
    "Failed selected tests: " +
      (evidence.failedTests.join(", ") || "none identified") +
      (evidence.omittedFailedTests
        ? " (" + evidence.omittedFailedTests + " more omitted)"
        : "") +
      ".",
    "Rust compiler error codes: " +
      (evidence.compilerErrorCodes.join(", ") || "none identified") +
      (evidence.omittedCompilerErrorCodes
        ? " (" + evidence.omittedCompilerErrorCodes + " more omitted)"
        : "") +
      ".",
    "Raw process output is withheld. Rerun the displayed scoped Cargo test from the checkout for deeper diagnostics.",
    "cargo test --manifest-path src-tauri/Cargo.toml --lib --jobs 2 -- " +
      selected +
      " --test-threads=2 --format=pretty --color=never",
  ];
  const error = verificationError(lines.join("\n"), {
    cause,
    status: result.status,
  });
  error.evidence = evidence;
  return error;
}

function safeProcessOutcome(result) {
  if (result.error) {
    return /^[A-Z][A-Z0-9_]{0,31}$/.test(result.error.code ?? "")
      ? result.error.code
      : "spawn error";
  }
  if (result.signal) {
    return /^SIG[A-Z0-9]{1,16}$/.test(result.signal) ? result.signal : "signal";
  }
  return Number.isInteger(result.status)
    ? String(result.status)
    : "missing status";
}

export function assertResourcePerformanceResults(output) {
  if (typeof output !== "string") {
    throw verificationError(
      "Resource performance verification returned no text output.",
    );
  }
  const seen = new Map(PERFORMANCE_TEST_FILTERS.map((name) => [name, 0]));
  const results = [];
  for (const line of output.split(/\r?\n/)) {
    const result = /^test (\S+) \.\.\. (.*)$/.exec(line);
    if (!result) continue;
    const [, name, outcome] = result;
    const matches = PERFORMANCE_TEST_FILTERS.filter(
      (expected) => name === expected || name.endsWith(`::${expected}`),
    );
    if (matches.length !== 1) {
      throw verificationError(
        "Unexpected or ambiguous resource regression test name.",
      );
    }
    const expected = matches[0];
    seen.set(expected, seen.get(expected) + 1);
    if (seen.get(expected) !== 1) {
      throw verificationError(
        `Duplicate resource regression test ${expected}.`,
      );
    }
    if (outcome !== "ok") {
      throw verificationError(
        `Resource regression test ${expected} was ${outcome === "FAILED" ? "FAILED" : outcome.startsWith("ignored") ? "ignored" : "an unknown outcome"}.`,
      );
    }
    results.push(name);
  }
  const missing = [...seen]
    .filter(([, count]) => count === 0)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw verificationError(
      `Missing resource regression tests: ${missing.join(", ")}.`,
    );
  }
  const summaries = [
    ...output.matchAll(
      /^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; \d+ filtered out;(?:.*)$/gm,
    ),
  ];
  if (
    summaries.length !== 1 ||
    summaries[0][1] !== "ok" ||
    Number(summaries[0][2]) !== PERFORMANCE_TEST_FILTERS.length ||
    summaries[0].slice(3, 6).some((count) => Number(count) !== 0)
  ) {
    throw verificationError(
      "Resource regression harness summary was missing or inconsistent.",
    );
  }
  return results;
}

export function verifyResourcePerformance({
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const result = spawn("cargo", [...CARGO_TEST_ARGS], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw cargoFailure(
      `Resource performance Cargo verification failed (${safeProcessOutcome(result)}).`,
      result,
    );
  }
  if (
    typeof result.stderr !== "string" ||
    /^error(?:\[E\d+\])?:/m.test(result.stderr) ||
    /^error(?:\[E\d+\])?:/m.test(result.stdout ?? "")
  ) {
    throw cargoFailure(
      "Resource performance Cargo verification reported an error.",
      result,
    );
  }
  let tests;
  try {
    tests = assertResourcePerformanceResults(result.stdout);
  } catch (error) {
    throw cargoFailure(error.message, result, error);
  }
  log(
    `Deterministic resource work-count coverage passed for ${tests.length} regression tests.`,
  );
  return tests;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    verifyResourcePerformance();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
