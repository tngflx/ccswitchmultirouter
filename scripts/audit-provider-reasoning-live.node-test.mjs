import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./audit-provider-reasoning-live.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("function classifyResult(");
const end = source.indexOf("async function worker()", start);
assert.ok(start >= 0 && end > start, "audit result classifier is available");
const classify = new Function(
  `${source.slice(start, end)}\nreturn classifyResult;`,
)();

test("records an exact effort echo separately from HTTP acceptance", () => {
  assert.equal(
    classify(
      { status: 200 },
      { effort: "max" },
      { reasoning: { effort: "max" } },
    ),
    "accepted-with-echo",
  );
  assert.equal(
    classify(
      { status: 200 },
      { effort: "max" },
      { reasoning: { effort: "high" } },
    ),
    "accepted-without-echo",
  );
});

test("a missing effort echo never becomes confirmed effort support", () => {
  assert.equal(
    classify({ status: 200 }, { effort: "max" }, { choices: [] }),
    "accepted-without-echo",
  );
  assert.equal(
    classify({ status: 200 }, { effort: "ultramax" }, { choices: [] }),
    "accepted-without-echo",
  );
});

test("recognizes explicit invalid-value rejection without treating rate limits as rejection", () => {
  assert.equal(
    classify(
      { status: 400 },
      { effort: "ultramax" },
      { error: { code: "invalid_value" } },
    ),
    "invalid-rejected",
  );
  assert.equal(
    classify(
      { status: 429 },
      { effort: "ultramax" },
      { error: { code: "invalid_value" } },
    ),
    "transient-or-inconclusive",
  );
});

test("recognizes numeric OpenRouter enum rejections only with explicit effort evidence", () => {
  for (const error of [
    {
      code: 400,
      message:
        'reasoning.effort: Invalid option: expected one of "low"|"medium"|"high"|"max"',
    },
    {
      code: 400,
      param: "reasoning.effort",
      message: 'Invalid option: expected one of "low"|"medium"|"high"|"max"',
    },
  ]) {
    assert.equal(
      classify({ status: 400 }, { effort: "ultramax" }, { error }),
      "invalid-rejected",
    );
    assert.equal(
      classify({ status: 429 }, { effort: "ultramax" }, { error }),
      "transient-or-inconclusive",
    );
  }

  for (const error of [
    { code: 400, message: "Invalid option for model selection" },
    { code: 400, param: "messages", message: "Invalid option" },
    {
      code: 400,
      param: "reasoning.effort",
      message: "Provider budget exhausted",
    },
  ]) {
    assert.equal(
      classify({ status: 400 }, { effort: "ultramax" }, { error }),
      "transient-or-inconclusive",
    );
  }
});

test("provider, transport, and HTTP-success error payloads remain inconclusive", () => {
  for (const response of [{ status: 502 }, { failure: "timeout" }]) {
    assert.equal(
      classify(response, { effort: "max" }, undefined),
      "transient-or-inconclusive",
    );
  }
  assert.equal(
    classify(
      { status: 200 },
      { effort: "max" },
      { error: { code: "invalid_value" } },
    ),
    "transient-or-inconclusive",
  );
});
