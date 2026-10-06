import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAddProviderMutation,
  useUpdateProviderMutation,
} from "@/lib/query/mutations";
import type { TeStaticProviderDescriptor } from "@/lib/api/providers";
import type { Provider } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

const api = vi.hoisted(() => ({
  saveTeProvider: vi.fn(),
  updateTrayMenu: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  providersApi: api,
  sessionsApi: {},
  settingsApi: {},
}));
vi.mock("sonner", () => ({ toast: notifications }));

const descriptor: TeStaticProviderDescriptor = {
  providerType: "token-exchange",
  providerId: "te-source",
  pluginId: "token-exchange",
  protocolVersion: "te-provider.v1",
  sidecarUrl: "http://127.0.0.1:8123",
  healthPath: "/healthz",
  expectedPartnerAic: "partner-test",
  models: [],
};
const provider: Provider = {
  id: "te-source",
  name: "TE source",
  settingsConfig: { api: "openai-completions", models: [] },
};

beforeEach(() => {
  vi.resetAllMocks();
  api.saveTeProvider.mockResolvedValue("stored_publish_failed");
  api.updateTrayMenu.mockResolvedValue(true);
});

async function setup(language: string) {
  const locale = await createLocalizedTestI18n(language);
  const client = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={locale}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
  const hook = renderHook(
    () => ({
      add: useAddProviderMutation("openclaw"),
      update: useUpdateProviderMutation("openclaw"),
    }),
    { wrapper },
  );
  return { ...hook, locale };
}

describe("TE saved-but-not-published localized outcomes", () => {
  it.each(["en", "zh", "zh-TW", "ja"])(
    "warns in %s for both mutations while preserving saved payloads and status",
    async (language) => {
      const { result, locale } = await setup(language);
      const originalDescriptor = structuredClone(descriptor);
      const originalProvider = structuredClone(provider);
      const { id, ...addInput } = provider;
      const added = await act(() =>
        result.current.add.mutateAsync({
          ...addInput,
          providerKey: id,
          teDescriptor: descriptor,
          addToLive: true,
        }),
      );
      expect(api.saveTeProvider).toHaveBeenLastCalledWith(
        { ...provider, createdAt: expect.any(Number) },
        descriptor,
        undefined,
        true,
      );
      expect(added).toMatchObject({
        ...provider,
        tePublishStatus: "stored_publish_failed",
      });
      expect(notifications.warning).toHaveBeenLastCalledWith(
        locale.t("notifications.teProviderSavePublishFailed"),
        { closeButton: true },
      );
      const updated = await act(() =>
        result.current.update.mutateAsync({
          provider,
          teDescriptor: descriptor,
          originalId: "previous-source",
        }),
      );
      expect(api.saveTeProvider).toHaveBeenLastCalledWith(
        provider,
        descriptor,
        "previous-source",
      );
      expect(updated).toEqual({
        provider,
        tePublishStatus: "stored_publish_failed",
      });
      expect(notifications.warning).toHaveBeenLastCalledWith(
        locale.t("notifications.teProviderUpdatePublishFailed"),
        { closeButton: true },
      );
      expect(notifications.warning).toHaveBeenCalledTimes(2);
      expect(notifications.success).not.toHaveBeenCalled();
      expect(notifications.error).not.toHaveBeenCalled();
      expect(api.saveTeProvider).toHaveBeenCalledTimes(2);
      expect(api.add).not.toHaveBeenCalled();
      expect(api.update).not.toHaveBeenCalled();
      expect(descriptor).toEqual(originalDescriptor);
      expect(provider).toEqual(originalProvider);
    },
  );

  it.each(["stored_and_published", "stored_not_published"])(
    "retains the existing success path for %s",
    async (status) => {
      api.saveTeProvider.mockResolvedValue(status);
      const { result, locale } = await setup("en");
      const { id, ...addInput } = provider;
      await act(() =>
        result.current.add.mutateAsync({
          ...addInput,
          providerKey: id,
          teDescriptor: descriptor,
        }),
      );
      expect(notifications.success).toHaveBeenLastCalledWith(
        locale.t("notifications.providerAdded"),
        { closeButton: true },
      );
      await act(() =>
        result.current.update.mutateAsync({
          provider,
          teDescriptor: descriptor,
        }),
      );
      expect(notifications.success).toHaveBeenLastCalledWith(
        locale.t("notifications.updateSuccess"),
        { closeButton: true },
      );
      expect(notifications.warning).not.toHaveBeenCalled();
      expect(notifications.error).not.toHaveBeenCalled();
    },
  );
});
