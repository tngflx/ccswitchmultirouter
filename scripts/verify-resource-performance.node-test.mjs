import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertResourcePerformanceResults,
  collectResourceFailureEvidence,
  MAX_FAILURE_EVIDENCE_ITEMS,
  CARGO_TEST_ARGS,
  MAX_CAPTURE_BYTES,
  PERFORMANCE_TEST_FILTERS,
  REPOSITORY_ROOT,
  verifyResourcePerformance,
} from "./verify-resource-performance.mjs";

const REQUIRED_ADDED_WORK_TESTS = Object.freeze([
  "parent_timeline_cache_retention_bounds_real_lookup_work",
  "parent_timeline_cache_admission_counts_capacity_and_allocations_separately",
  "oversized_parent_timeline_returns_all_signatures_without_retaining_history",
  "responses_stream_priming_fragmented_work_is_linear",
  "responses_stream_priming_many_lifecycle_frames_are_inspected_once",
  "responses_stream_priming_wrapper_work_is_linear",
  "native_usage_scan_cadence_skips_unchanged_sources_until_due",
  "repeated_incomplete_usage_scans_keep_the_normal_work_bound",
  "native_usage_sources_keep_shared_target_ids_and_dedupe_websocket_aliases",
  "text_sse_frames_scan_each_wire_byte_once_across_fragment_sizes",
  "complete_sse_blocks_scan_each_frame_once",
  "partial_custom_input_decoder_scans_appended_bytes_once",
  "repeated_call_updates_size_only_new_items",
  "repeated_deferred_polls_parse_only_through_first_unsettled_turn",
  "rich_descriptor_join_scans_each_descriptor_and_alias_matched_row_once",
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

function outputFor(
  names = PERFORMANCE_TEST_FILTERS,
  transform = (line) => line,
) {
  return [
    `running ${names.length} tests`,
    ...names.map((name) => transform(`test module::tests::${name} ... ok`)),
    `test result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; 1000 filtered out; finished in 0.01s`,
    "",
  ].join("\n");
}

function runWith(overrides = {}, log = () => {}) {
  return verifyResourcePerformance({
    spawn: () => ({ status: 0, stdout: outputFor(), stderr: "", ...overrides }),
    log,
  });
}

test("runs one fixed Cargo process with bounded capture and concurrency", () => {
  const calls = [];
  const logs = [];
  const result = verifyResourcePerformance({
    spawn: (...args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: outputFor(),
        stderr: "Compiling ccswitchmulti\n",
      };
    },
    log: (message) => logs.push(message),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "cargo",
    [
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
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  ]);
  assert.equal(calls[0][2].cwd, REPOSITORY_ROOT);
  assert.equal(calls[0][2].maxBuffer, MAX_CAPTURE_BYTES);
  assert.deepEqual(calls[0][1], CARGO_TEST_ARGS);
  assert.equal(result.length, PERFORMANCE_TEST_FILTERS.length);
  assert.deepEqual(logs, [
    `Deterministic resource work-count coverage passed for ${PERFORMANCE_TEST_FILTERS.length} regression tests.`,
  ]);
  assert.doesNotMatch(logs.join(""), /CPU|percent|hang-proof/i);
});

test("configuration selects all 86 unique explicit regression names", () => {
  assert.equal(PERFORMANCE_TEST_FILTERS.length, 86);
  assert.ok(
    PERFORMANCE_TEST_FILTERS.includes(
      "retryable_child_snapshot_reuse_bounds_parsing_and_retained_records",
    ),
  );
  assert.ok(
    PERFORMANCE_TEST_FILTERS.includes(
      "retryable_parent_timeline_checks_exact_bytes_without_reparsing_unchanged_history",
    ),
  );
  for (const name of REQUIRED_ADDED_WORK_TESTS) {
    assert.ok(PERFORMANCE_TEST_FILTERS.includes(name));
  }
  assert.equal(
    new Set(PERFORMANCE_TEST_FILTERS).size,
    PERFORMANCE_TEST_FILTERS.length,
  );
  assert.ok(
    PERFORMANCE_TEST_FILTERS.every((name) => /^[a-z][a-z0-9_]+$/.test(name)),
  );
  assert.ok(Object.isFrozen(PERFORMANCE_TEST_FILTERS));
  assert.ok(Object.isFrozen(CARGO_TEST_ARGS));
});

test("accepts exact unqualified names and Windows CRLF output", () => {
  const output = outputFor()
    .replaceAll("module::tests::", "")
    .replaceAll("\n", "\r\n");
  assert.equal(
    assertResourcePerformanceResults(output).length,
    PERFORMANCE_TEST_FILTERS.length,
  );
});

test("zero tests with successful Cargo status fails closed", () => {
  assert.throws(
    () => runWith({ stdout: outputFor([]) }),
    /Missing resource regression tests/,
  );
});

test("missing retryable-child work regression fails closed", () => {
  const omitted =
    "retryable_child_snapshot_reuse_bounds_parsing_and_retained_records";
  assert.throws(
    () =>
      runWith({
        stdout: outputFor(
          PERFORMANCE_TEST_FILTERS.filter((name) => name !== omitted),
        ),
      }),
    /Missing resource regression tests/,
  );
});

for (const omitted of REQUIRED_ADDED_WORK_TESTS) {
  test(`missing ${omitted} work regression fails closed`, () => {
    assert.throws(
      () =>
        runWith({
          stdout: outputFor(
            PERFORMANCE_TEST_FILTERS.filter((name) => name !== omitted),
          ),
        }),
      /Missing resource regression tests/,
    );
  });
}

test("a partial successful run fails closed", () => {
  assert.throws(
    () => runWith({ stdout: outputFor(PERFORMANCE_TEST_FILTERS.slice(1)) }),
    /Missing resource regression tests/,
  );
});

for (const outcome of [
  "FAILED",
  "ignored",
  "ignored, expensive regression",
  "unknown outcome",
]) {
  test(`rejects ${outcome} named result despite exit zero`, () => {
    assert.throws(
      () =>
        runWith({ stdout: outputFor().replace(" ... ok", ` ... ${outcome}`) }),
      /was (FAILED|ignored|an unknown outcome)/,
    );
  });
}

for (const suffix of ["_extra", "_prefix_impostor"]) {
  test(`rejects substring-similar test name ${suffix}`, () => {
    assert.throws(
      () =>
        runWith({
          stdout: outputFor().replace(
            PERFORMANCE_TEST_FILTERS[0],
            PERFORMANCE_TEST_FILTERS[0] + suffix,
          ),
        }),
      /Unexpected or ambiguous/,
    );
  });
}

test("rejects prefix-similar unqualified names", () => {
  assert.throws(
    () =>
      runWith({
        stdout: outputFor().replace(
          `module::tests::${PERFORMANCE_TEST_FILTERS[0]}`,
          `prefix_${PERFORMANCE_TEST_FILTERS[0]}`,
        ),
      }),
    /Unexpected or ambiguous/,
  );
});

test("rejects duplicated and differently qualified ambiguous matches", () => {
  for (const prefix of ["module::tests::", "other_module::"]) {
    assert.throws(
      () =>
        runWith({
          stdout:
            outputFor() +
            `test ${prefix}${PERFORMANCE_TEST_FILTERS[0]} ... ok\n`,
        }),
      /Duplicate resource regression test/,
    );
  }
});

test("rejects unexpected failed or ignored results", () => {
  for (const outcome of ["FAILED", "ignored", "ok"]) {
    assert.throws(
      () =>
        runWith({
          stdout: outputFor() + `test unrelated_test ... ${outcome}\n`,
        }),
      /Unexpected or ambiguous/,
    );
  }
});

test("requires one consistent successful harness summary", () => {
  for (const stdout of [
    outputFor().replace(/^test result:.*$/m, ""),
    outputFor() + outputFor().match(/^test result:.*$/m)[0] + "\n",
    outputFor().replace("result: ok.", "result: FAILED."),
    outputFor().replace(
      `${PERFORMANCE_TEST_FILTERS.length} passed`,
      "0 passed",
    ),
    outputFor().replace("0 failed", "1 failed"),
    outputFor().replace("0 ignored", "1 ignored"),
    outputFor().replace("0 measured", "1 measured"),
  ]) {
    assert.throws(() => runWith({ stdout }), /harness summary/);
  }
});

test("propagates nonzero Cargo exit status", () => {
  assert.throws(
    () => runWith({ status: 101 }),
    (error) => error.exitCode === 101,
  );
});

test("spawn errors and capture overflow fail with their cause", () => {
  for (const code of ["ENOENT", "ENOBUFS"]) {
    const cause = Object.assign(new Error(code), { code });
    assert.throws(
      () => runWith({ error: cause, status: null }),
      (error) => error.cause === cause && error.exitCode === 1,
    );
  }
});

test("signals and missing statuses fail closed", () => {
  for (const overrides of [
    { status: null, signal: "SIGTERM" },
    { status: 0, signal: "SIGTERM" },
    { status: undefined },
  ]) {
    assert.throws(() => runWith(overrides), /Cargo verification failed/);
  }
});

test("Cargo diagnostic errors fail despite a successful injected status", () => {
  for (const diagnostic of [
    "error: test failed\n",
    "error[E0425]: missing value\n",
  ]) {
    assert.throws(() => runWith({ stderr: diagnostic }), /reported an error/);
    assert.throws(
      () => runWith({ stdout: outputFor() + diagnostic }),
      /reported an error/,
    );
  }
});

test("missing captured output fails closed", () => {
  assert.throws(() => runWith({ stdout: null }), /no text output/);
  assert.throws(() => runWith({ stderr: null }), /reported an error/);
});

test("failures never emit a success claim", () => {
  const logs = [];
  assert.throws(() =>
    runWith({ stdout: outputFor([]) }, (message) => logs.push(message)),
  );
  assert.deepEqual(logs, []);
});

test("nonzero exit exposes selected failed test evidence and scoped rerun command", () => {
  const name = PERFORMANCE_TEST_FILTERS[3];
  assert.throws(
    () =>
      runWith({
        status: 101,
        stdout: "test services::tests::" + name + " ... FAILED\n",
      }),
    (error) => {
      assert.equal(error.exitCode, 101);
      assert.deepEqual(error.evidence.failedTests, [name]);
      assert.match(
        error.message,
        /Command context: cargo test --manifest-path/,
      );
      assert.match(error.message, /Rerun the displayed scoped Cargo test/);
      assert.ok(
        error.message.includes(
          "cargo test --manifest-path src-tauri/Cargo.toml --lib --jobs 2 -- " +
            name +
            " --test-threads=2 --format=pretty --color=never",
        ),
      );
      return true;
    },
  );
});

test("compiler failure exposes only diagnostic IDs and fixed scoped rerun", () => {
  assert.throws(
    () =>
      runWith({
        status: 101,
        stdout: "",
        stderr: "error[E0063]: missing fixture field\n",
      }),
    (error) => {
      assert.deepEqual(error.evidence.compilerErrorCodes, ["E0063"]);
      assert.match(error.message, /Rust compiler error codes: E0063/);
      assert.doesNotMatch(error.message, /missing fixture field/);
      assert.ok(
        error.message.includes(
          "-- " + PERFORMANCE_TEST_FILTERS[0] + " --test-threads=2",
        ),
      );
      return true;
    },
  );
});

test("structured failure evidence is deduplicated and truncated with omitted counts", () => {
  const stdout = PERFORMANCE_TEST_FILTERS.map(
    (name) => "test module::" + name + " ... FAILED\n",
  ).join("");
  const codes = Array.from(
    { length: 20 },
    (_, index) => "E" + String(index).padStart(4, "0"),
  );
  const stderr = codes
    .map((code) => "error[" + code + "]: arbitrary details\n")
    .join("");
  const evidence = collectResourceFailureEvidence({
    stdout: stdout + stdout,
    stderr: stderr + stderr,
  });
  assert.equal(evidence.failedTests.length, MAX_FAILURE_EVIDENCE_ITEMS);
  assert.equal(evidence.compilerErrorCodes.length, MAX_FAILURE_EVIDENCE_ITEMS);
  assert.equal(
    evidence.omittedFailedTests,
    PERFORMANCE_TEST_FILTERS.length - MAX_FAILURE_EVIDENCE_ITEMS,
  );
  assert.equal(
    evidence.omittedCompilerErrorCodes,
    codes.length - MAX_FAILURE_EVIDENCE_ITEMS,
  );
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.failedTests));
  assert.ok(Object.isFrozen(evidence.compilerErrorCodes));
  assert.throws(
    () => runWith({ status: 101, stdout, stderr }),
    (error) => {
      assert.match(error.message, /more omitted/);
      assert.ok(Buffer.byteLength(error.message) < 4096);
      assert.doesNotMatch(error.message, /arbitrary details/);
      assert.ok(!error.message.includes(codes[MAX_FAILURE_EVIDENCE_ITEMS]));
      return true;
    },
  );
});

test("failure evidence accepts strict selected harness lines and compiler code syntax", () => {
  const name = PERFORMANCE_TEST_FILTERS[0];
  const evidence = collectResourceFailureEvidence({
    stdout: [
      "test module::" + name + " ... FAILED trailing details",
      "prefix test module::" + name + " ... FAILED",
      "test malformed-name::" + name + " ... FAILED",
      "test unrelated_secret_fixture ... FAILED",
      "test module::" + name + " ... FAILED\r\n",
    ].join("\n"),
    stderr:
      "error[E0063]: details\nerror[E0063]: repeated\nerror[E00630]: invalid\ninfo error[E0123]: invalid\n",
  });
  assert.deepEqual(evidence.failedTests, [name]);
  assert.deepEqual(evidence.compilerErrorCodes, ["E0063"]);
});

test("arbitrary process secrets and fixture text are withheld on every failure path", () => {
  const secret = "sk-mock-API-secret-never-emit-123";
  const bearer = "Bearer mock-token-never-emit-456";
  const arbitrary =
    "Authorization: " +
    bearer +
    "\napi_key=" +
    secret +
    "\nassertion fixture: private request body\n";
  const cases = [
    { status: 101, stdout: arbitrary, stderr: arbitrary },
    {
      stdout: outputFor() + arbitrary,
      stderr: "error[E0063]: " + secret + "\n" + arbitrary,
    },
    {
      stdout: outputFor().replace(" ... ok", " ... ignored, " + bearer),
      stderr: arbitrary,
    },
    {
      stdout: outputFor().replace(" ... ok", " ... " + secret),
      stderr: arbitrary,
    },
    {
      stdout: outputFor() + "test " + secret + " ... FAILED\n",
      stderr: arbitrary,
    },
    {
      status: null,
      error: Object.assign(new Error(arbitrary), { code: "ENOBUFS" }),
      stdout: arbitrary,
      stderr: arbitrary,
    },
    {
      status: null,
      error: Object.assign(new Error(arbitrary), { code: bearer }),
      stdout: arbitrary,
      stderr: arbitrary,
    },
  ];
  for (const overrides of cases) {
    const logs = [];
    assert.throws(
      () => runWith(overrides, (message) => logs.push(message)),
      (error) => {
        const emitted =
          error.message + JSON.stringify(error.evidence) + logs.join("\n");
        assert.ok(!emitted.includes(secret));
        assert.ok(!emitted.includes(bearer));
        assert.doesNotMatch(
          emitted,
          /private request body|Authorization|api_key/,
        );
        assert.match(error.message, /Raw process output is withheld/);
        return true;
      },
    );
  }
});

test("spawn and capture failures retain bounded cause codes in emitted diagnostics", () => {
  for (const code of ["ENOENT", "ENOBUFS"]) {
    const cause = Object.assign(new Error("withheld underlying details"), {
      code,
    });
    assert.throws(
      () => runWith({ status: null, error: cause }),
      (error) => {
        assert.equal(error.cause, cause);
        assert.ok(error.message.includes("failed (" + code + ")"));
        assert.doesNotMatch(error.message, /withheld underlying details/);
        return true;
      },
    );
  }
});
