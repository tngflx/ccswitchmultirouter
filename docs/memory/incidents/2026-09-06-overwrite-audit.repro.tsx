// Audit fixture: copy to tests/components/OverwriteAudit.repro.test.tsx to reproduce.
// Assertions describe the required behavior and currently fail; see the audit report.
import React from "react";
import { act, render, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import JsonEditor from "@/components/JsonEditor";
import MarkdownEditor from "@/components/MarkdownEditor";
import { useOpencodeFormState } from "@/components/providers/forms/hooks/useOpencodeFormState";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { useOpenclawFormState } from "@/components/providers/forms/hooks/useOpenclawFormState";
import { useHermesFormState } from "@/components/providers/forms/hooks/useHermesFormState";

const query = vi.hoisted(() => ({
  data: { language: "en", claudeConfigDir: "original", showInTray: true },
}));
vi.mock("@/lib/query", () => ({
  useSettingsQuery: () => ({ data: query.data, isLoading: false }),
}));
vi.mock("@/lib/query/queries", () => ({
  useProvidersQuery: () => ({ data: { providers: {} } }),
}));
const translation = vi.hoisted(() => ({
  t: (key: string) => key,
  i18n: { language: "en", changeLanguage: vi.fn() },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => translation }));
afterEach(cleanup);

for (const [name, Editor] of [
  ["JSON", JsonEditor],
  ["Markdown", MarkdownEditor],
] as const) {
  it(`${name} user edits should call the latest callback`, () => {
    const oldCallback = vi.fn();
    const newCallback = vi.fn();
    const ui = render(<Editor value="{}" onChange={oldCallback} />);
    ui.rerender(<Editor value="{}" onChange={newCallback} />);
    const view = EditorView.findFromDOM(
      ui.container.querySelector(".cm-editor")!,
    )!;
    act(() =>
      view.dispatch({ changes: { from: 0, to: 2, insert: '{"edited":true}' } }),
    );
    expect(newCallback).toHaveBeenCalledWith('{"edited":true}');
    expect(oldCallback).not.toHaveBeenCalled();
  });
  it(`${name} external hydration should not echo a user change`, () => {
    const callback = vi.fn();
    const ui = render(<Editor value="{}" onChange={callback} />);
    ui.rerender(<Editor value={'{"loaded":true}'} onChange={callback} />);
    expect(callback).not.toHaveBeenCalled();
  });
}

it("OpenCode structured edits should retain models added in raw JSON", () => {
  const initial = {
    npm: "@ai-sdk/openai-compatible",
    models: { first: { name: "First" } },
  };
  let raw = JSON.stringify(initial);
  const { result, rerender } = renderHook(() =>
    useOpencodeFormState({
      initialData: { settingsConfig: initial },
      appId: "opencode",
      providerId: "example",
      getSettingsConfig: () => raw,
      onSettingsConfigChange: (value) => {
        raw = value;
      },
    }),
  );
  raw = JSON.stringify({
    ...initial,
    models: { ...initial.models, addedInJson: { name: "Added" } },
  });
  rerender();
  act(() =>
    result.current.handleOpencodeModelsChange({
      ...result.current.opencodeModels,
      first: { name: "Edited" },
    }),
  );
  expect(JSON.parse(raw).models).toHaveProperty("addedInJson");
});

it("settings refetch should preserve an unsaved directory edit", () => {
  const { result, rerender } = renderHook(() => useSettingsForm());
  act(() =>
    result.current.updateSettings({ claudeConfigDir: "unsaved-directory" }),
  );
  query.data = { ...query.data, showInTray: false };
  rerender();
  expect(result.current.settings?.claudeConfigDir).toBe("unsaved-directory");
});

it("OpenClaw structured edits should retain models added in raw JSON", () => {
  const initial = { models: [{ id: "first", name: "First" }] };
  let raw = JSON.stringify(initial);
  const { result, rerender } = renderHook(() =>
    useOpenclawFormState({
      initialData: { settingsConfig: initial },
      appId: "openclaw",
      providerId: "example",
      getSettingsConfig: () => raw,
      onSettingsConfigChange: (value) => {
        raw = value;
      },
    }),
  );
  raw = JSON.stringify({
    models: [...initial.models, { id: "addedInJson", name: "Added" }],
  });
  rerender();
  act(() =>
    result.current.handleOpenclawModelsChange(
      result.current.openclawModels.map((model) => ({
        ...model,
        name: "Edited",
      })),
    ),
  );
  expect(
    JSON.parse(raw).models.some(
      (model: { id: string }) => model.id === "addedInJson",
    ),
  ).toBe(true);
});

it("Hermes structured edits should retain models added in raw JSON", () => {
  const initial = { models: [{ id: "first", name: "First" }] };
  let raw = JSON.stringify(initial);
  const { result, rerender } = renderHook(() =>
    useHermesFormState({
      initialData: { settingsConfig: initial },
      appId: "hermes",
      providerId: "example",
      getSettingsConfig: () => raw,
      onSettingsConfigChange: (value) => {
        raw = value;
      },
    }),
  );
  raw = JSON.stringify({
    models: [...initial.models, { id: "addedInJson", name: "Added" }],
  });
  rerender();
  act(() =>
    result.current.handleHermesModelsChange(
      result.current.hermesModels.map((model) => ({
        ...model,
        name: "Edited",
      })),
    ),
  );
  expect(
    JSON.parse(raw).models.some(
      (model: { id: string }) => model.id === "addedInJson",
    ),
  ).toBe(true);
});
