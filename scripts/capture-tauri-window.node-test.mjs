import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("./capture-tauri-window.ps1", import.meta.url),
  "utf8",
);

test("Tauri capture enables DPI awareness before reading window rectangles", () => {
  const awarenessCall = script.indexOf(
    "[TauriCaptureNative]::SetProcessDpiAwarenessContext",
  );
  const firstWindowQuery = script.indexOf("function Get-ProcessWindows");

  assert.match(script, /IntPtr\]::new\(-4\)/);
  assert.ok(awarenessCall >= 0, "missing per-monitor-v2 awareness call");
  assert.ok(firstWindowQuery >= 0, "missing window enumeration helper");
  assert.ok(
    awarenessCall < firstWindowQuery,
    "DPI awareness must be set before GetWindowRect is used",
  );
});
