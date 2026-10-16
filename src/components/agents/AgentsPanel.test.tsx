import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPanel } from "./AgentsPanel";
import i18n from "i18next";
import english from "@/i18n/locales/en.json";

const orchestrationMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  listRuns: vi.fn(),
  cancelRun: vi.fn(),
}));

const providerMocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  inspectActiveCodexMultiRouterProjection: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  orchestrationApi: orchestrationMocks,
  providersApi: providerMocks,
}));

describe("AgentsPanel orchestration profile editor", () => {
  beforeEach(async () => {
    i18n.addResourceBundle("en", "translation", english);
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    providerMocks.inspectActiveCodexMultiRouterProjection.mockResolvedValue(
      null,
    );
    orchestrationMocks.getSettings.mockResolvedValue({
      enabled: false,
      profiles: [],
      defaultModeByApp: { claude: "direct", codex: "direct" },
    });
    orchestrationMocks.listRuns.mockResolvedValue([]);
    orchestrationMocks.saveSettings.mockImplementation(async (settings) => ({
      settings,
      codexProjection: null,
      publicationError: null,
    }));
  });
  it("saves a new disabled draft without implicitly enabling routing", async () => {
    orchestrationMocks.getSettings.mockResolvedValue({
      enabled: false,
      profiles: [],
      defaultModeByApp: { claude: "direct", codex: "direct" },
    });
    orchestrationMocks.listRuns.mockResolvedValue([]);
    orchestrationMocks.saveSettings.mockImplementation(async (settings) => ({
      settings,
      codexProjection: null,
      publicationError: null,
    }));
    providerMocks.getAll.mockImplementation(async (appType: string) =>
      appType === "claude"
        ? {
            "claude-official": {
              id: "claude-official",
              name: "Claude Official",
              settingsConfig: {},
              category: "official",
              sortIndex: 0,
            },
          }
        : {
            sublyx: {
              id: "sublyx",
              name: "Sublyx",
              settingsConfig: {
                modelCatalog: { models: [{ model: "gpt-6.1-sol-sublyx" }] },
              },
              category: "custom",
              sortIndex: 0,
            },
          },
    );

    render(<AgentsPanel onOpenChange={vi.fn()} />);
    await screen.findByText("Multimodel orchestration");

    fireEvent.click(screen.getByTitle("Add profile"));
    const orchestratorModel = await screen.findByLabelText(
      "Orchestrator model ID",
    );
    fireEvent.change(orchestratorModel, {
      target: { value: "claude-sonnet-4-20250514" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          profiles: [
            expect.objectContaining({
              enabled: false,
              orchestrator: expect.objectContaining({
                model: "claude-sonnet-4-20250514",
              }),
            }),
          ],
        }),
      ),
    );
    expect(
      orchestrationMocks.saveSettings.mock.calls[0][0].activeProfileId,
    ).toBeUndefined();
  });

  it("keeps an authoritative empty catalog closed and does not select router providers", async () => {
    providerMocks.getAll.mockImplementation(async (app: string) =>
      app === "claude"
        ? {
            planner: {
              id: "planner",
              name: "Planner",
              settingsConfig: { env: { ANTHROPIC_MODEL: "planner-model" } },
            },
          }
        : {
            router: {
              id: "router",
              name: "A Router",
              settingsConfig: {
                codexRouting: { schemaVersion: 2, enabled: true },
              },
            },
            worker: {
              id: "worker",
              name: "Worker",
              settingsConfig: {
                modelCatalog: {
                  models: [{ model: "excluded", enabled: false }],
                },
                model_catalog: { models: [{ model: "stale" }] },
                model: "fallback",
              },
            },
          },
    );
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    await screen.findByText("Multimodel orchestration");
    fireEvent.click(screen.getByTitle("Add profile"));
    expect(screen.getByLabelText("Worker model ID")).toBeDisabled();
    // Empty authoritative inventories cannot route, but must not prevent
    // persisting an incomplete, disabled draft.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Profile enabled"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByText("A Router")).not.toBeInTheDocument();
    expect(screen.queryByText("excluded")).not.toBeInTheDocument();
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
  });

  it("shows a retry when settings save but catalog publication fails", async () => {
    providerMocks.getAll.mockImplementation(async (app: string) => ({
      source: { id: "source", name: app, settingsConfig: { model: "model" } },
    }));
    orchestrationMocks.saveSettings.mockImplementation(async (settings) => ({
      settings,
      codexProjection: null,
      publicationError: "projection_publish_failed",
    }));
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    await screen.findByText("Multimodel orchestration");
    fireEvent.click(screen.getByTitle("Add profile"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("button", { name: "Retry publication" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry publication" }));
    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledTimes(2),
    );
  });

  function settingsWithProfiles() {
    const role = {
      appType: "codex",
      providerId: "source",
      model: "model",
    };
    return {
      enabled: true,
      activeProfileId: "primary",
      defaultModeByApp: { claude: "direct", codex: "orchestrated" },
      profiles: ["primary", "secondary"].map((id) => ({
        id,
        displayName: id,
        enabled: true,
        scope: "all",
        orchestrator: role,
        worker: role,
        budget: {
          maxRounds: 2,
          maxWorkerCalls: 2,
          maxParallelWorkers: 1,
          timeoutSeconds: 300,
          maxOutputTokens: 8192,
        },
        approvalPolicy: "client",
        failureFallback: "fail_closed",
        workerGuidance: "",
      })),
    };
  }

  function mockExistingProfiles() {
    orchestrationMocks.getSettings.mockResolvedValue(settingsWithProfiles());
    providerMocks.getAll.mockResolvedValue({
      source: {
        id: "source",
        name: "Source",
        settingsConfig: { modelCatalog: { models: ["model"] } },
      },
    });
  }

  it("does not activate a profile just by browsing it", async () => {
    mockExistingProfiles();
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /secondary/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ activeProfileId: "primary" }),
      ),
    );
  });

  it("preserves the active profile and default modes when adding a draft", async () => {
    mockExistingProfiles();
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    await screen.findByText("Multimodel orchestration");
    fireEvent.click(screen.getByTitle("Add profile"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProfileId: "primary",
          defaultModeByApp: { claude: "direct", codex: "orchestrated" },
          profiles: expect.arrayContaining([
            expect.objectContaining({ enabled: false }),
          ]),
        }),
      ),
    );
  });

  it("preserves the active profile when deleting another profile", async () => {
    const settings = settingsWithProfiles();
    settings.activeProfileId = "secondary";
    orchestrationMocks.getSettings.mockResolvedValue(settings);
    providerMocks.getAll.mockResolvedValue({
      source: {
        id: "source",
        name: "Source",
        settingsConfig: { model: "model" },
      },
    });
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /primary/ }));
    fireEvent.click(screen.getByTitle("Delete profile"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ activeProfileId: "secondary" }),
      ),
    );
  });

  it("can delete the last profile and return default routing to direct", async () => {
    mockExistingProfiles();
    const settings = settingsWithProfiles();
    settings.profiles = settings.profiles.slice(0, 1);
    orchestrationMocks.getSettings.mockResolvedValue(settings);
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    await screen.findByText("Multimodel orchestration");
    fireEvent.click(screen.getByTitle("Delete profile"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProfileId: undefined,
          profiles: [],
          defaultModeByApp: { claude: "direct", codex: "direct" },
        }),
      ),
    );
  });

  it("can save incomplete disabled drafts without any providers", async () => {
    providerMocks.getAll.mockResolvedValue({});
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    await screen.findByText("Multimodel orchestration");
    fireEvent.click(screen.getByTitle("Add profile"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          profiles: [
            expect.objectContaining({
              enabled: false,
              worker: { appType: "codex", providerId: "", model: "" },
            }),
          ],
        }),
      ),
    );
  });

  it("changes the active profile only through the explicit default-profile action", async () => {
    mockExistingProfiles();
    render(<AgentsPanel onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /secondary/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Use as default profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(orchestrationMocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProfileId: "secondary",
          defaultModeByApp: { claude: "direct", codex: "orchestrated" },
        }),
      ),
    );
  });
});
