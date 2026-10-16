import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import english from "@/i18n/locales/en.json";
import { OrchestrationSummaryCard } from "./OrchestrationSummaryCard";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  inspectActiveCodexMultiRouterProjection: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  orchestrationApi: {
    getSettings: mocks.getSettings,
  },
  providersApi: {
    inspectActiveCodexMultiRouterProjection:
      mocks.inspectActiveCodexMultiRouterProjection,
  },
}));

describe("OrchestrationSummaryCard", () => {
  const renderCard = (onOpen: () => void) =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <OrchestrationSummaryCard onOpen={onOpen} />
      </QueryClientProvider>,
    );

  beforeEach(async () => {
    i18n.addResourceBundle("en", "translation", english);
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
  });

  it("shows the saved profile and opens the editor from the Codex main page", async () => {
    mocks.getSettings.mockResolvedValue({
      enabled: true,
      activeProfileId: "research-ensemble",
      profiles: [
        {
          id: "research-ensemble",
          displayName: "Research Ensemble",
          enabled: true,
          scope: "codex",
          orchestrator: {
            appType: "claude",
            providerId: "claude-official",
            model: "claude-sonnet-4-20250514",
          },
          worker: {
            appType: "codex",
            providerId: "codex-official",
            model: "gpt-6.1-sol",
          },
          budget: {
            maxRounds: 3,
            maxWorkerCalls: 3,
            maxParallelWorkers: 1,
            timeoutSeconds: 600,
            maxOutputTokens: 8192,
          },
          approvalPolicy: "client",
          failureFallback: "fail_closed",
          workerGuidance: "",
        },
      ],
      defaultModeByApp: { claude: "direct", codex: "direct" },
    });
    mocks.inspectActiveCodexMultiRouterProjection.mockResolvedValue({
      state: "ready",
    });
    const onOpen = vi.fn();

    renderCard(onOpen);

    expect(await screen.findByText("Research Ensemble")).toBeInTheDocument();
    expect(screen.getByText("gpt-6.1-sol")).toBeInTheDocument();
    expect(await screen.findByText("Published")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows a clear empty state instead of inventing a profile", async () => {
    mocks.getSettings.mockResolvedValue({
      enabled: false,
      profiles: [],
      defaultModeByApp: { claude: "direct", codex: "direct" },
    });

    renderCard(vi.fn());

    await waitFor(() =>
      expect(
        screen.getByText("No enabled orchestration profile yet."),
      ).toBeInTheDocument(),
    );
    expect(
      mocks.inspectActiveCodexMultiRouterProjection,
    ).not.toHaveBeenCalled();
  });
});
