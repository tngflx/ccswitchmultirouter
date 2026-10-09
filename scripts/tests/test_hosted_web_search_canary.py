import copy
import importlib.util
import io
from pathlib import Path
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "canary", Path(__file__).parents[1] / "verify_third_party_hosted_web_search.py"
)
canary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canary)


def completed():
    return [{
        "type": "response.completed",
        "response": {"status": "completed", "output": [
            {"type": "web_search_call", "status": "completed", "id": "synthetic"},
            {"type": "message", "content": [{"type": "output_text", "text": canary.MARKER}]},
        ]},
    }]


class CanaryTests(unittest.TestCase):
    def test_search_payload_avoids_optional_provider_specific_limits(self):
        payload = canary.search_payload("fixture-model")
        self.assertNotIn("max_tool_calls", payload)
        self.assertEqual(payload["tools"], [{"type": "web_search"}])
        self.assertEqual(payload["tool_choice"], {"type": "web_search"})

    def test_multiline_sse_crlf_comments_and_named_events(self):
        data = b': keepalive\r\nevent: response.completed\r\ndata: {"response":\r\ndata: {"status":"completed"}}\r\n\r\ndata: [DONE]\r\n\r\n'
        events = canary.read_sse(io.BytesIO(data))
        self.assertEqual(events[0]["type"], "response.completed")
        self.assertEqual(events[0]["response"]["status"], "completed")
        self.assertEqual(len(events), 1)

    def test_limits_and_invalid_json(self):
        with patch.object(canary, "MAX_CAPTURE_BYTES", 10):
            with self.assertRaisesRegex(canary.CanaryFailure, "capture_limit"):
                canary.read_sse(io.BytesIO(b"data: " + b"x" * 11))
        with patch.object(canary, "MAX_EVENTS", 1):
            with self.assertRaisesRegex(canary.CanaryFailure, "event_limit"):
                canary.read_sse(io.BytesIO(b'data: {}\n\ndata: {}\n\n'))
        with self.assertRaisesRegex(canary.CanaryFailure, "suite_timeout"):
            canary.read_sse(io.BytesIO(), time.monotonic() - 1)
        for data in [b"data: invalid\n\n", b"data: []\n\n"]:
            with self.assertRaises(canary.CanaryFailure):
                canary.read_sse(io.BytesIO(data))

    def test_requires_real_search_marker_and_terminal_completion(self):
        self.assertEqual(canary.assess(completed(), 200, "search")["status"], "ok")
        events = completed()
        events[0]["response"]["output"] = events[0]["response"]["output"][1:]
        self.assertEqual(canary.assess(events, 200, "search")["status"], "failed")
        for events in [
            [{"type": "response.output_text.delta", "delta": canary.MARKER}],
            completed() + [{"type": "response.failed", "error": {"message": "private"}}],
            completed() + [{"type": "response.error", "error": {"message": "private"}}],
            completed() + [{"type": "response.incomplete"}],
        ]:
            result = canary.assess(events, 200, "search")
            self.assertEqual(result["status"], "failed")
            self.assertNotIn("private", str(result))
        self.assertEqual(canary.assess(completed(), 503, "search")["status"], "failed")

    def test_replay_uses_only_generated_history_omits_tools_and_is_independent(self):
        initial = canary.search_payload("fixture-model")
        events = completed()
        original = copy.deepcopy(events)
        for lite in [False, True]:
            replay = canary.replay_payload("fixture-model", initial, events, lite)
            self.assertEqual(replay["input"][-1]["type"], "compaction_trigger")
            self.assertEqual(replay["tool_choice"], "none")
            self.assertEqual(replay.get("tools", []), [])
            replay["input"][1]["id"] = "changed"
        self.assertEqual(events, original)
        with self.assertRaisesRegex(canary.CanaryFailure, "synthetic_search_history_missing"):
            canary.replay_payload("fixture-model", initial, [], False)

    def test_compaction_requires_compaction_output(self):
        self.assertEqual(canary.assess(completed(), 200, "standard_compaction_replay")["status"], "failed")
        events = [{"type": "response.completed", "response": {
            "status": "completed", "output": [{"type": "compaction", "encrypted_content": "private"}]
        }}]
        result = canary.assess(events, 200, "lite_compaction_replay")
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("private", str(result))

    def test_failure_stops_suite_and_does_not_print_response_body(self):
        with patch.object(canary, "send", return_value=(200, completed() + [{"type":"response.failed"}])) as send:
            with patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(canary.main(["--suite", "replay"]), 1)
                self.assertNotIn("output_text", output.getvalue())
            self.assertEqual(send.call_count, 1)


if __name__ == "__main__":
    unittest.main()
