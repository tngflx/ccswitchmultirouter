import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import type { ReactNode } from "react";

import { CodexGlobalConfigSettings } from "@/components/settings/CodexGlobalConfigSettings";
import { configApi } from "@/lib/api";
import { isCodexGoalModeEnabled } from "@/utils/providerConfigUtils";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
    id,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    id: string;
    ariaLabel: string;
  }) => (
    <textarea
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/lib/api", () => ({
  configApi: {
    getCommonConfigSnippet: vi.fn(),
    setCommonConfigSnippet: vi.fn(),
  },
}));

describe("CodexGlobalConfigSettings", () => {
  let locale: i18n;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={locale}>{children}</I18nextProvider>
  );

  beforeEach(async () => {
    locale = await createLocalizedTestI18n();
    vi.mocked(configApi.getCommonConfigSnippet).mockReset();
    vi.mocked(configApi.setCommonConfigSnippet).mockReset();
    vi.mocked(configApi.getCommonConfigSnippet).mockResolvedValue(
      'model_reasoning_summary = "auto"\n',
    );
    vi.mocked(configApi.setCommonConfigSnippet).mockResolvedValue(undefined);
  });

  it("loads and saves the shared Codex TOML from global settings", async () => {
    render(<CodexGlobalConfigSettings />, { wrapper });

    expect(await screen.findByLabelText("Global Codex TOML")).toHaveValue(
      'model_reasoning_summary = "auto"\n',
    );

    fireEvent.change(screen.getByLabelText("Global Codex TOML"), {
      target: { value: 'model_reasoning_summary = "none"\n' },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save global Codex configuration" }),
    );

    await waitFor(() =>
      expect(configApi.setCommonConfigSnippet).toHaveBeenCalledWith(
        "codex",
        'model_reasoning_summary = "none"\n',
      ),
    );
  });

  it("owns the Goal mode switch outside individual providers", async () => {
    render(<CodexGlobalConfigSettings />, { wrapper });

    const goalMode = await screen.findByRole("checkbox", {
      name: "Enable Goal mode",
    });
    expect(goalMode).not.toBeChecked();

    fireEvent.click(goalMode);

    expect(
      isCodexGoalModeEnabled(
        (screen.getByLabelText("Global Codex TOML") as HTMLTextAreaElement)
          .value,
      ),
    ).toBe(true);
  });

  it("fails closed after a load error and retries before exposing editable shared config", async () => {
    vi.mocked(configApi.getCommonConfigSnippet)
      .mockRejectedValueOnce(new Error("shared config unavailable"))
      .mockResolvedValueOnce('model_reasoning_summary = "none"\n');

    render(<CodexGlobalConfigSettings />, { wrapper });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load global Codex configuration: shared config unavailable",
    );
    expect(
      screen.queryByLabelText("Global Codex TOML"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Enable Goal mode" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save global Codex configuration" }),
    ).not.toBeInTheDocument();
    expect(configApi.setCommonConfigSnippet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));

    expect(await screen.findByLabelText("Global Codex TOML")).toHaveValue(
      'model_reasoning_summary = "none"\n',
    );
    expect(
      screen.getByRole("checkbox", { name: "Enable Goal mode" }),
    ).toBeInTheDocument();
    expect(configApi.getCommonConfigSnippet).toHaveBeenCalledTimes(2);
  });

  it("changes all four UI locales without refetching or dropping unsaved TOML", async () => {
    const { container } = render(<CodexGlobalConfigSettings />, { wrapper });
    const editor = await screen.findByLabelText("Global Codex TOML");
    const edited = '# retain my comment\nmodel_reasoning_summary = "none"\n';
    fireEvent.change(editor, { target: { value: edited } });
    expect(container.textContent).not.toMatch(/\p{Script=Han}/u);

    for (const language of ["zh", "zh-TW", "ja", "en"]) {
      await act(() => locale.changeLanguage(language));
      expect(
        screen.getByLabelText(locale.t("codexGlobalConfig.toml")),
      ).toHaveValue(edited);
      expect(
        screen.getByRole("button", {
          name: locale.t("codexGlobalConfig.save"),
        }),
      ).toBeEnabled();
      expect(configApi.getCommonConfigSnippet).toHaveBeenCalledTimes(1);
      expect(configApi.setCommonConfigSnippet).not.toHaveBeenCalled();
    }
  });

  it("keeps failed saves editable and localizes the error prefix without refetching", async () => {
    vi.mocked(configApi.setCommonConfigSnippet).mockRejectedValueOnce(
      new Error("write denied"),
    );
    render(<CodexGlobalConfigSettings />, { wrapper });
    const edited = 'model_reasoning_summary = "none"\n';
    fireEvent.change(await screen.findByLabelText("Global Codex TOML"), {
      target: { value: edited },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save global Codex configuration" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to save global Codex configuration: write denied",
    );
    await act(() => locale.changeLanguage("zh-TW"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      locale.t("codexGlobalConfig.saveError", { error: "write denied" }),
    );
    expect(
      screen.getByLabelText(locale.t("codexGlobalConfig.toml")),
    ).toHaveValue(edited);
    expect(
      screen.getByRole("button", { name: locale.t("codexGlobalConfig.save") }),
    ).toBeEnabled();
    expect(configApi.getCommonConfigSnippet).toHaveBeenCalledTimes(1);
    expect(configApi.setCommonConfigSnippet).toHaveBeenCalledTimes(1);
  });
});
