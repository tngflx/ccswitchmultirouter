import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { HostedToolsSwitchPanel } from "@/components/codex/HostedToolsSwitchPanel";
import {
  ExternalBackendPicker,
  SelectedBackendSummary,
} from "@/components/openai/ExternalBackendPicker";
import {
  buildProfileUpdate,
  chooseDefaultBackendKey,
  describeBackendTarget,
  displayBackendDescription,
  groupBackendOptions,
  profileBackendKey,
} from "@/lib/openai/externalProfile";
import type { ExternalOpenAIAPIBackendOption } from "@/types/proxy";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

function backend(
  overrides: Partial<ExternalOpenAIAPIBackendOption> = {},
): ExternalOpenAIAPIBackendOption {
  return {
    key: "provider::codex::source::",
    backendType: "provider",
    appType: "codex",
    providerId: "source",
    label: "Source A",
    description: "OpenAI-compatible provider",
    models: ["model-a", "model-b"],
    isManagedOAuth: false,
    available: true,
    ...overrides,
  };
}

describe("localized child owners with production locale resources", () => {
  let locale: i18n;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={locale}>{children}</I18nextProvider>
  );
  beforeEach(async () => {
    locale = await createLocalizedTestI18n();
  });

  it("localizes hosted-tool labels while preserving the other toggle and disabled state", async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <HostedToolsSwitchPanel
        webSearchEnabled={false}
        imageGenerationEnabled
        onChange={onChange}
      />,
      { wrapper },
    );
    expect(container.textContent).not.toMatch(/\p{Script=Han}/u);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Web Search hosted tool bridge" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      webSearchEnabled: true,
      imageGenerationEnabled: true,
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Image Generation hosted tool bridge",
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      webSearchEnabled: false,
      imageGenerationEnabled: false,
    });
    for (const language of ["zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      expect(
        screen.getByRole("checkbox", {
          name: locale.t("codexHostedTools.webSearchLabel"),
        }),
      ).not.toBeChecked();
      expect(
        screen.getByRole("checkbox", {
          name: locale.t("codexHostedTools.imageGenerationLabel"),
        }),
      ).toBeChecked();
    }
    rerender(
      <HostedToolsSwitchPanel
        webSearchEnabled={false}
        imageGenerationEnabled
        disabled
        onChange={onChange}
      />,
    );
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeDisabled();
      await userEvent.click(checkbox);
    }
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("keeps grouping, raw descriptions, default selection, and saved profile identifiers invariant across locales", () => {
    const compatible = backend();
    const official = backend({
      key: "official",
      providerId: "official-source",
      isManagedOAuth: true,
      description: "Managed OAuth provider",
    });
    const router = backend({
      key: "router",
      providerId: "router-source",
      description: "Codex router provider",
    });
    const route = backend({
      key: "route",
      backendType: "codex_router_route",
      providerId: "router-source",
      routeId: "stable-route",
      description: "Codex router route",
    });
    const unavailable = backend({ key: "unavailable", available: false });
    const options = [compatible, route, unavailable, official, router];
    const original = structuredClone(options);
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      const t = locale.getFixedT(language);
      const groups = groupBackendOptions(options, t);
      expect(groups.map(({ key }) => key)).toEqual([
        "official",
        "router",
        "compatible",
        "unavailable",
      ]);
      expect(groups[1].options.map(({ key }) => key)).toEqual([
        "route",
        "router",
      ]);
      expect(groups[1].label).toBe(t("externalApi.source.router"));
      expect(chooseDefaultBackendKey(options, [])).toBe("official");
      expect(chooseDefaultBackendKey(options, ["unavailable"])).toBe(
        "unavailable",
      );
      expect(buildProfileUpdate(route, "model-b", false)).toMatchObject({
        backendType: "codex_router_route",
        providerId: "router-source",
        routeId: "stable-route",
        defaultModel: "model-b",
        enabled: false,
      });
      expect(
        profileBackendKey(buildProfileUpdate(route, "model-b", false)),
      ).toBe("codex_router_route::codex::router-source::stable-route");
      expect(describeBackendTarget(router, t).compatibility).toContain(
        "/v1/responses",
      );
      expect(describeBackendTarget(compatible, t).compatibility).toContain(
        t("externalApi.source.chatOnly"),
      );
      expect(displayBackendDescription("Unknown backend marker", t)).toBe(
        "Unknown backend marker",
      );
    }
    expect(options).toEqual(original);
  });

  it("renders English counts, known errors, raw unknown diagnostics, and stable selection IDs", () => {
    const onSelect = vi.fn();
    const missing = backend({
      key: "missing",
      label: "Missing source",
      available: false,
      error: "no usable base URL or credential",
    });
    const unknown = backend({
      key: "unknown",
      label: "Unknown source",
      available: false,
      error: "diagnostic-code-123",
    });
    const groups = groupBackendOptions([backend(), missing, unknown], locale.t);
    const { container } = render(
      <ExternalBackendPicker
        groups={groups}
        selectedKey=""
        onSelect={onSelect}
      />,
      { wrapper },
    );
    expect(container.textContent).not.toMatch(/\p{Script=Han}/u);
    expect(screen.getByText("Sources: 2")).toBeInTheDocument();
    expect(
      screen.getByText(locale.t("externalApi.source.errors.credentials")),
    ).toBeInTheDocument();
    expect(screen.getByText("diagnostic-code-123")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Missing source/ }));
    expect(onSelect).toHaveBeenLastCalledWith("missing");
    fireEvent.click(screen.getByRole("button", { name: /Source A/ }));
    expect(onSelect).toHaveBeenLastCalledWith("provider::codex::source::");
  });

  it.each(["en", "zh", "zh-TW", "ja"])(
    "localizes summaries and empty states in %s without hiding unavailability",
    async (language) => {
      await locale.changeLanguage(language);
      const unavailable = backend({ available: false });
      const { rerender } = render(
        <SelectedBackendSummary
          backend={unavailable}
          description={describeBackendTarget(unavailable, locale.t)}
          hasDraftChanges
        />,
        { wrapper },
      );
      expect(
        screen.getByText(locale.t("externalApi.source.pending")),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          locale.t("externalApi.source.modelCount", { count: 2 }),
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: locale.t("externalApi.source.cannotEnable"),
        }),
      ).toBeDisabled();
      const button = screen.getByRole("button");
      expect(within(button).queryByText("model-b")).not.toBeInTheDocument();
      rerender(
        <ExternalBackendPicker groups={[]} selectedKey="" onSelect={vi.fn()} />,
      );
      expect(
        screen.getByText(locale.t("externalApi.source.empty")),
      ).toBeInTheDocument();
    },
  );
});
