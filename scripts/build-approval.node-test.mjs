import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILD_APPROVAL_ENV,
  BUILD_APPROVAL_SCOPE_ENV,
  createBuildApprovalScope,
  hasBuildApproval,
  removeBuildApprovalFlag,
  requireBuildApproval,
} from "./build-approval.mjs";
import { prepareTauriCommand } from "./tauri-command.mjs";

test("public build approval is denied by default and requires the explicit flag", () => {
  assert.equal(hasBuildApproval([], {}), false);
  assert.throws(
    () =>
      requireBuildApproval({
        args: [],
        environment: {},
        operation: "test build",
      }),
    /explicit user approval/,
  );
  assert.equal(hasBuildApproval(["--confirm-build"], {}), true);
  assert.equal(hasBuildApproval([], { [BUILD_APPROVAL_ENV]: "1" }), false);
  assert.equal(
    hasBuildApproval(
      [],
      { [BUILD_APPROVAL_ENV]: "1" },
      {
        allowEnvironmentApproval: true,
      },
    ),
    false,
  );
  assert.throws(
    () =>
      requireBuildApproval({
        args: [],
        environment: { [BUILD_APPROVAL_ENV]: "1" },
        operation: "public build",
      }),
    /explicit user approval/,
  );
  const approval = createBuildApprovalScope({});
  assert.equal(typeof approval.environment[BUILD_APPROVAL_SCOPE_ENV], "string");
  assert.equal(
    hasBuildApproval([], approval.environment, {
      allowEnvironmentApproval: true,
    }),
    true,
  );
  approval.cleanup();
  assert.equal(
    hasBuildApproval([], approval.environment, {
      allowEnvironmentApproval: true,
    }),
    false,
  );
});

test("approval flag is removed before forwarding to child build tools", () => {
  assert.deepEqual(
    removeBuildApprovalFlag(["build", "--confirm-build", "--bundles", "nsis"]),
    ["build", "--bundles", "nsis"],
  );
});

test("Tauri build requires approval and passes a scoped token to beforeBuildCommand", () => {
  assert.throws(
    () => prepareTauriCommand(["--config", "tauri.conf.json", "build"], {}),
    /explicit user approval/,
  );
  assert.throws(
    () => prepareTauriCommand(["build"], { [BUILD_APPROVAL_ENV]: "1" }),
    /explicit user approval/,
  );
  const prepared = prepareTauriCommand(
    ["build", "--confirm-build", "--bundles", "nsis"],
    {},
  );
  assert.deepEqual(prepared.args, ["build", "--bundles", "nsis"]);
  assert.equal(typeof prepared.environment[BUILD_APPROVAL_ENV], "string");
  assert.equal(typeof prepared.environment[BUILD_APPROVAL_SCOPE_ENV], "string");
  assert.equal(
    hasBuildApproval([], prepared.environment, {
      allowEnvironmentApproval: true,
    }),
    true,
  );
  prepared.cleanup();
});

test("renderer approval accepts only the scoped internal token or explicit flag", () => {
  assert.throws(
    () =>
      requireBuildApproval({
        args: [],
        environment: { [BUILD_APPROVAL_ENV]: "1" },
        operation: "the renderer build",
      }),
    /explicit user approval/,
  );
  const approval = createBuildApprovalScope({});
  assert.doesNotThrow(() =>
    requireBuildApproval({
      args: [],
      environment: approval.environment,
      allowEnvironmentApproval: true,
      operation: "the renderer build",
    }),
  );
  approval.cleanup();
});

test("Tauri development compile requires the same explicit approval", () => {
  assert.throws(
    () => prepareTauriCommand(["dev", "--no-watch"], {}),
    /explicit user approval/,
  );
  const prepared = prepareTauriCommand(["dev", "--confirm-build"], {});
  assert.deepEqual(prepared.args, ["dev"]);
  assert.equal(typeof prepared.environment[BUILD_APPROVAL_ENV], "string");
  prepared.cleanup();
});
