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
  it("lets a catalog-less Claude provider use a typed model ID and enables projection on profile creation", async () => {
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
          enabled: true,
          profiles: [
            expect.objectContaining({
              orchestrator: expect.objectContaining({
                model: "claude-sonnet-4-20250514",
              }),
            }),
          ],
        }),
      ),
    );
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
});
