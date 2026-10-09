"""Run a real third-party Codex hosted web_search canary through CCSM.

The local proxy owns provider credentials. This script only sends the
PROXY_MANAGED marker and never reads or prints stored secrets.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import time
import urllib.request
import urllib.error
import uuid


ENDPOINT = "http://127.0.0.1:15721/v1/responses"
MODEL = os.environ.get("CCSM_CANARY_MODEL", "qwen3.8")
MARKER = "CCSM_THIRD_PARTY_HOSTED_SEARCH_OK"
MAX_CAPTURE_BYTES = 2 * 1024 * 1024
MAX_EVENTS = 4096
MAX_LINE_BYTES = 512 * 1024
SUITE_TIMEOUT_SECONDS = 240
READ_TIMEOUT_SECONDS = 30


class CanaryFailure(Exception):
    """Contains only a fixed diagnostic code, never response text."""


def read_sse(response, deadline: float | None = None) -> list[dict]:
    deadline = deadline or time.monotonic() + SUITE_TIMEOUT_SECONDS
    events: list[dict] = []
    data_lines: list[str] = []
    event_type = ""
    captured_bytes = 0
    pending = b""

    def dispatch() -> None:
        nonlocal event_type
        data = "\n".join(data_lines)
        data_lines.clear()
        if data and data != "[DONE]":
            try:
                payload = json.loads(data)
            except ValueError as error:
                raise CanaryFailure("invalid_sse_json") from error
            if not isinstance(payload, dict):
                raise CanaryFailure("invalid_sse_object")
            if event_type and "type" not in payload:
                payload["type"] = event_type
            events.append(payload)
            if len(events) > MAX_EVENTS:
                raise CanaryFailure("event_limit_exceeded")
        event_type = ""

    def lines():
        nonlocal captured_bytes, pending
        while True:
            if time.monotonic() >= deadline:
                raise CanaryFailure("suite_timeout")
            # read1 returns currently available bytes; readline could wait
            # indefinitely for a slow peer to finish a line.
            chunk = response.read1(64 * 1024)
            if time.monotonic() >= deadline:
                raise CanaryFailure("suite_timeout")
            captured_bytes += len(chunk)
            if captured_bytes > MAX_CAPTURE_BYTES:
                raise CanaryFailure("capture_limit_exceeded")
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if len(line) > MAX_LINE_BYTES:
                    raise CanaryFailure("line_limit_exceeded")
                yield line
            if len(pending) > MAX_LINE_BYTES:
                raise CanaryFailure("line_limit_exceeded")
            if not chunk:
                if pending:
                    yield pending
                return

    for raw_line in lines():
        if time.monotonic() >= deadline:
            raise CanaryFailure("suite_timeout")
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if not line:
            dispatch()
        elif line.startswith("data:"):
            value = line[5:]
            data_lines.append(value[1:] if value.startswith(" ") else value)
        elif line.startswith("event:"):
            event_type = line[6:].strip()
    dispatch()
    return events


def search_payload(model: str) -> dict:
    return {
        "model": model,
        "stream": True,
        "store": False,
        "max_output_tokens": 4096,
        "reasoning": {"effort": "low"},
        "include": ["reasoning.encrypted_content"],
        "tool_choice": {"type": "web_search"},
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "Use the web_search tool exactly once to search for "
                            "'OpenAI Codex web search'. Then reply only with "
                            f"{MARKER}."
                        ),
                    }
                ],
            }
        ],
        "tools": [{"type": "web_search"}],
    }


def terminal_output(events: list[dict]) -> list[dict]:
    for event in reversed(events):
        if event.get("type") == "response.completed":
            output = event.get("response", {}).get("output", [])
            if isinstance(output, list):
                return [item for item in output if isinstance(item, dict)]
    return []


def assess(events: list[dict], http_status: int, stage: str) -> dict:
    output = terminal_output(events)
    completed = any(
        event.get("type") == "response.completed"
        and event.get("response", {}).get("status") == "completed"
        and not event.get("response", {}).get("error")
        for event in events
    )
    failed = any(
        event.get("type") in {"error", "response.error", "response.failed", "response.incomplete"}
        for event in events
    )
    search_items = [
        item for item in output
        if item.get("type") == "web_search_call" and item.get("status") == "completed"
    ]
    search_observed = bool(search_items) or any(
        event.get("type") == "response.web_search_call.completed" for event in events
    )
    marker_present = any(
        MARKER in str(content.get("text", ""))
        for item in output
        for content in item.get("content", []) if isinstance(content, dict)
    ) or any(
        MARKER in str(event.get("text", ""))
        for event in events if event.get("type") == "response.output_text.done"
    )
    compaction_output = any(item.get("type") == "compaction" for item in output)
    succeeded = http_status == 200 and completed and not failed
    if stage == "search":
        succeeded = succeeded and search_observed and marker_present and bool(search_items)
    else:
        succeeded = succeeded and compaction_output
    return {
        "stage": stage,
        "status": "ok" if succeeded else "failed",
        "http_status": http_status,
        "event_count": len(events),
        "completed": completed,
        "failed_terminal": failed,
        "search_observed": search_observed,
        "marker_present": marker_present,
        "compaction_output": compaction_output,
    }


def replay_payload(model: str, initial: dict, events: list[dict], lite: bool) -> dict:
    output = terminal_output(events)
    if not any(item.get("type") == "web_search_call" for item in output):
        raise CanaryFailure("synthetic_search_history_missing")
    # Only history generated by this synthetic request is eligible for replay.
    # Omit all tools deliberately, exercising the runtime's shared repair.
    payload = {
        "model": model,
        "stream": True,
        "store": False,
        "max_output_tokens": 4096,
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "none",
        "input": copy.deepcopy(initial["input"] + output)
        + [{"type": "compaction_trigger"}],
    }
    if not lite:
        payload["tools"] = []
    return payload


def send(payload: dict, session_id: str, deadline: float, lite: bool = False) -> tuple:
    headers = {
        "Authorization": "Bearer PROXY_MANAGED",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "Codex Desktop/third-party-hosted-search-canary",
        "session_id": session_id,
        "x-codex-turn-metadata": "ccsm-third-party-hosted-search-canary",
    }
    if lite:
        headers["x-openai-internal-codex-responses-lite"] = "true"
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
    )
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CanaryFailure("suite_timeout")
    with urllib.request.urlopen(
        request, timeout=min(READ_TIMEOUT_SECONDS, remaining)
    ) as response:
        events = read_sse(response, deadline)
        return response.status, events


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=["search", "replay"], default="search")
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args(argv)
    session_id = f"third-party-hosted-search-{uuid.uuid4()}"
    started = time.monotonic()
    deadline = started + SUITE_TIMEOUT_SECONDS
    results = []
    stage = "search"
    try:
        initial = search_payload(args.model)
        status, search_events = send(initial, session_id, deadline)
        results.append(assess(search_events, status, stage))
        if results[-1]["status"] == "ok" and args.suite == "replay":
            for stage, lite in [("standard_compaction_replay", False), ("lite_compaction_replay", True)]:
                payload = replay_payload(args.model, initial, search_events, lite)
                status, events = send(payload, session_id, deadline, lite)
                results.append(assess(events, status, stage))
                if results[-1]["status"] != "ok":
                    break
    except urllib.error.HTTPError as error:
        results.append({"stage": stage, "status": "error", "http_status": error.code})
    except Exception as error:
        results.append({
            "stage": stage,
            "status": "error",
            "error": str(error) if isinstance(error, CanaryFailure) else type(error).__name__,
        })
    expected_stages = 3 if args.suite == "replay" else 1
    succeeded = len(results) == expected_stages and all(
        result["status"] == "ok" for result in results
    )
    result = {
        "status": "ok" if succeeded else "failed",
        "model": args.model,
        "session_id": session_id,
        "suite": args.suite,
        "checks": results,
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
