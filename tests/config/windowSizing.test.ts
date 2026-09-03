import { describe, expect, it } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import windowsTauriConfig from "../../src-tauri/tauri.windows.conf.json";
import defaultCapability from "../../src-tauri/capabilities/default.json";

describe("main window sizing", () => {
  it("opens new installations at a roomy desktop viewport", () => {
    const mainWindow = tauriConfig.app.windows[0];

    expect(mainWindow.width).toBe(1440);
    expect(mainWindow.height).toBe(1080);
    expect(mainWindow.minWidth).toBe(1100);
    expect(mainWindow.minHeight).toBe(760);
  });

  it("keeps the Windows minimum size aligned with the base window", () => {
    const windowsMainWindow = windowsTauriConfig.app.windows[0];

    expect(windowsMainWindow.minWidth).toBe(1100);
    expect(windowsMainWindow.minHeight).toBe(760);
  });

  it("allows the renderer to apply the shared WebView zoom", () => {
    expect(defaultCapability.permissions).toContain(
      "core:webview:allow-set-webview-zoom",
    );
  });
});
