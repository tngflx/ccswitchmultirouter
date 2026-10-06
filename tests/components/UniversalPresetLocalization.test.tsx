import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import { UniversalProviderFormModal } from "@/components/universal/UniversalProviderFormModal";
import { ProviderPresetSelector } from "@/components/providers/forms/ProviderPresetSelector";
import {
  createUniversalProviderFromPreset,
  getPresetDescription,
  getPresetDisplayName,
  universalProviderPresets,
} from "@/config/universalProviderPresets";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

vi.mock("@/components/JsonEditor", () => ({
  default: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

// Icons receive the raw provider name as metadata; it is not a visible label.
vi.mock("@/components/ProviderIcon", () => ({
  ProviderIcon: () => <span aria-hidden />,
}));

const customPreset = universalProviderPresets.find(
  (preset) => preset.providerType === "custom_gateway",
)!;

describe("universal preset locale ownership", () => {
  it.each(["en", "zh", "zh-TW", "ja"])(
    "renders localized labels and descriptions with %s resources",
    async (language) => {
      const locale = await createLocalizedTestI18n(language);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <I18nextProvider i18n={locale}>{children}</I18nextProvider>
      );
      render(
        <UniversalProviderFormModal
          isOpen
          initialPreset={customPreset}
          onClose={vi.fn()}
          onSaveAndSync={vi.fn()}
        />,
        { wrapper },
      );
      const customName = locale.t("universalProvider.presets.customGateway");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: customName })).toBeVisible(),
      );
      expect(
        screen.getByLabelText(locale.t("universalProvider.name")),
      ).toHaveValue(customName);
      expect(
        screen.getByText(
          locale.t("universalProvider.presets.customGatewayDescription"),
        ),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "NewAPI" }));
      expect(
        screen.getByText(
          locale.t("universalProvider.presets.newapiDescription"),
        ),
      ).toBeVisible();
      expect(
        screen.getByLabelText(locale.t("universalProvider.name")),
      ).toHaveValue("NewAPI");
    },
  );

  it("does not reset unsaved names, credentials, models, or app toggles when the locale changes", async () => {
    const locale = await createLocalizedTestI18n();
    render(
      <I18nextProvider i18n={locale}>
        <UniversalProviderFormModal
          isOpen
          initialPreset={customPreset}
          onClose={vi.fn()}
          onSaveAndSync={vi.fn()}
        />
      </I18nextProvider>,
    );
    const values: Record<string, string> = {
      name: "My private gateway",
      baseUrl: "https://draft.example/v1",
      apiKey: "draft-placeholder",
      notes: "Keep this draft",
    };
    for (const [id, value] of Object.entries(values)) {
      fireEvent.change(document.getElementById(id)!, {
        target: { value },
      });
    }
    const modelField = screen.getByDisplayValue("gpt-5.6-sol");
    fireEvent.change(modelField, { target: { value: "custom-model" } });
    const appToggle = screen.getAllByRole("switch")[0];
    fireEvent.click(appToggle);

    for (const language of ["zh", "zh-TW", "ja", "en"]) {
      await act(() => locale.changeLanguage(language));
      for (const [id, value] of Object.entries(values)) {
        expect(document.getElementById(id)).toHaveValue(value);
      }
      expect(screen.getByDisplayValue("custom-model")).toHaveValue(
        "custom-model",
      );
      expect(screen.getAllByRole("switch")[0]).not.toBeChecked();
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: locale.t("universalProvider.presets.customGateway"),
          }),
        ).toBeVisible(),
      );
    }
  });

  it("retains stored names and unknown preset metadata rather than translating persisted data", async () => {
    const locale = await createLocalizedTestI18n();
    const storedProvider = createUniversalProviderFromPreset(
      customPreset,
      "stored-gateway",
      "https://stored.example/v1",
      "placeholder",
      "用户保留的名称",
    );
    const storedSnapshot = structuredClone(storedProvider);
    render(
      <I18nextProvider i18n={locale}>
        <UniversalProviderFormModal
          isOpen
          editingProvider={storedProvider}
          onClose={vi.fn()}
          onSaveAndSync={vi.fn()}
        />
      </I18nextProvider>,
    );
    const unknownPreset = {
      ...customPreset,
      providerType: "third-party-extension",
      name: "Extension-specific name",
      description: "Extension-specific description",
    };
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      expect(
        screen.getByLabelText(locale.t("universalProvider.name")),
      ).toHaveValue(storedProvider.name);
      expect(getPresetDisplayName(unknownPreset, locale.t)).toBe(
        unknownPreset.name,
      );
      expect(getPresetDescription(unknownPreset, locale.t)).toBe(
        unknownPreset.description,
      );
    }
    expect(storedProvider).toEqual(storedSnapshot);
  });

  it("uses the same display helper in the provider selector without changing the selected preset identity", async () => {
    const locale = await createLocalizedTestI18n();
    const onUniversalPresetSelect = vi.fn();
    function Selector() {
      const form = useForm();
      return (
        <Form {...form}>
          <ProviderPresetSelector
            selectedPresetId="custom"
            presetEntries={[]}
            presetCategoryLabels={{}}
            onPresetChange={vi.fn()}
            onUniversalPresetSelect={onUniversalPresetSelect}
          />
        </Form>
      );
    }
    render(
      <I18nextProvider i18n={locale}>
        <Selector />
      </I18nextProvider>,
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      fireEvent.click(
        screen.getByRole("button", {
          name: new RegExp(locale.t("universalProvider.presets.customGateway")),
        }),
      );
      expect(onUniversalPresetSelect).toHaveBeenLastCalledWith(customPreset);
    }
    expect(onUniversalPresetSelect).toHaveBeenCalledTimes(4);
  });
});
