import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexCompatibilitySummary } from "@/components/providers/forms/CodexCompatibilitySummary";
import { CodexProtocolProbeProgressDialog } from "@/components/providers/forms/CodexProtocolProbeProgressDialog";
import type {
  CodexProtocolCompatibilityRecord,
  CodexProtocolProbeProgressEvent,
  CodexProviderProtocolPreflightOutcome,
} from "@/lib/api/protocol-compatibility";
import { createLocalizedTestI18n } from "../utils/localizedTestI18n";

const record: CodexProtocolCompatibilityRecord = {
  probeVersion: 6,
  target: {
    provider_id: "source",
    route_id: null,
    public_model: "stable-model",
    upstream_model: "upstream-model",
    transport: "open_ai_responses",
    endpoint_fingerprint: "endpoint",
    authentication_kind: "bearer",
    credential_fingerprint: "credential",
    request_policy_fingerprint: "policy",
  },
  result: {
    selected_transport: "open_ai_chat",
    readiness: "verified",
    branches: [
      {
        assessment: {
          transport: "open_ai_responses",
          baseline: "failed",
          streaming: "skipped",
          forced_tool: "skipped",
          continuation: "skipped",
        },
        reasoning_shape: {
          semantic: "none",
          source: "none",
          pre_tool_visible_content: "absent",
        },
        failures: [
          { stage: "baseline", kind: "http_status", status_code: 401 },
        ],
      },
      {
        assessment: {
          transport: "open_ai_chat",
          baseline: "passed",
          streaming: "passed",
          forced_tool: "passed",
          continuation: "passed",
        },
        reasoning_shape: {
          semantic: "readable",
          source: "reasoning_content",
          pre_tool_visible_content: "absent",
        },
        tool_schema_dialect: "openai",
        history_replay: "chat_reasoning_content",
        failures: [],
      },
    ],
  },
  testedAt: 1,
  expiresAt: 2,
};

const outcome: CodexProviderProtocolPreflightOutcome = {
  provider: { id: "source", name: "Stable source", settingsConfig: {} },
  adaptationPreview: {
    persistence: "single",
    status: "ready",
    effectiveTransport: "open_ai_chat",
    models: [],
  },
  records: [record],
  observations: [],
  receiptIds: ["stable-receipt"],
  protocolApplied: false,
  probeUsage: {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 150,
    reportedResponses: 1,
    successfulResponses: 3,
    estimatedCostUsd: "0.0015",
    pricedModels: ["stable-model"],
    unpricedModels: ["unknown-price"],
  },
};

describe("localized protocol evidence with production resources", () => {
  let locale: i18n;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={locale}>{children}</I18nextProvider>
  );
  beforeEach(async () => {
    locale = await createLocalizedTestI18n();
  });

  it("switches summary caveats without fabricating reasoning or active configuration", async () => {
    render(
      <CodexCompatibilitySummary
        transport="open_ai_responses"
        readiness="verified"
        baselinePassed
        reasoningSemantic="opaque"
        reasoningSource="native_responses"
        toolSchemaDialect="openai"
        historyReplay="native_only"
        retries={[]}
        running={false}
        selected={false}
      />,
      { wrapper },
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      expect(screen.getByRole("status")).toHaveTextContent(
        locale.t("codexCompatibilitySummary.passed"),
      );
      for (const key of ["noReasoning", "fallback", "evidenceOnly"]) {
        expect(
          screen.getByText(locale.t(`codexCompatibilitySummary.${key}`)),
        ).toBeInTheDocument();
      }
      expect(
        screen.queryByText(locale.t("codexCompatibilitySummary.adaptedPassed")),
      ).not.toBeInTheDocument();
    }
  });

  it("preserves expanded mappings, raw identity, usage caveats and exact selection payloads when switching locales", async () => {
    const onSelectTransport = vi.fn();
    const original = structuredClone(outcome);
    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["stable-model"]}
        expectedTargets={[
          {
            providerId: "source",
            providerName: "Stable source",
            model: "stable-model",
          },
        ]}
        events={[]}
        outcome={outcome}
        error=""
        onOpenChange={vi.fn()}
        onSelectTransport={onSelectTransport}
      />,
      { wrapper },
    );
    const chat = screen.getByText("Chat Completions").closest("section")!;
    fireEvent.click(
      within(chat).getByRole("button", {
        name: locale.t("codexProtocolProbe.viewMappings"),
      }),
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      expect(screen.getByText("Stable source")).toBeInTheDocument();
      expect(screen.getByText("stable-model")).toBeInTheDocument();
      expect(
        within(chat).getByRole("button", {
          name: locale.t("codexProtocolProbe.viewMappings"),
        }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(
        within(chat).getByText(
          "choices[].delta.reasoning_content → response.reasoning_text.delta",
        ),
      ).toBeInTheDocument();
      expect(
        within(chat).getByText(locale.t("codexProtocolProbe.mappingSaved")),
      ).toBeInTheDocument();
      expect(
        screen.getByText(locale.t("codexProtocolProbe.http401")),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          locale.t("codexProtocolProbe.unreportedUsage", { total: 2 }),
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          locale.t("codexProtocolProbe.unpricedModels", {
            models: "unknown-price",
          }),
        ),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: locale.t("codexProtocolProbe.selectModelTransport", {
            arg0: "stable-model",
            arg1: locale.t("codexProtocolProbe.select"),
            arg2: "Chat Completions",
          }),
        }),
      );
      expect(onSelectTransport).toHaveBeenLastCalledWith({
        model: "stable-model",
        providerId: "source",
        transport: "open_ai_chat",
        readiness: "verified",
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: locale.t("codexProtocolProbe.selectModelTransport", {
            arg0: "stable-model",
            arg1: locale.t("codexProtocolProbe.useAnyway"),
            arg2: "Responses",
          }),
        }),
      );
      expect(onSelectTransport).toHaveBeenLastCalledWith({
        model: "stable-model",
        providerId: "source",
        transport: "open_ai_responses",
        readiness: "unverified",
      });
    }
    expect(onSelectTransport).toHaveBeenCalledTimes(8);
    expect(outcome).toEqual(original);
  });

  it("localizes running and retry controls without enabling close or promoting incomplete evidence", async () => {
    const onOpenChange = vi.fn();
    const onRetry = vi.fn();
    const events: CodexProtocolProbeProgressEvent[] = [
      {
        kind: "stage_started",
        model: "stable-model",
        transport: "open_ai_chat",
        stage: "baseline",
      },
    ];
    const props = {
      open: true,
      running: true,
      expectedModels: ["stable-model"],
      events,
      outcome: null,
      error: "",
      onOpenChange,
      onRetry,
    };
    const { rerender } = render(
      <CodexProtocolProbeProgressDialog {...props} />,
      { wrapper },
    );
    for (const language of ["en", "zh", "zh-TW", "ja"]) {
      await act(() => locale.changeLanguage(language));
      expect(
        screen.getByRole("button", {
          name: locale.t("codexProtocolProbe.running"),
        }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("button", {
          name: locale.t("codexProtocolProbe.retry"),
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(locale.t("codexCompatibilitySummary.passed")),
      ).not.toBeInTheDocument();
    }
    rerender(
      <CodexProtocolProbeProgressDialog
        {...props}
        running={false}
        error="diagnostic-code-123"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("diagnostic-code-123");
    fireEvent.click(
      screen.getByRole("button", {
        name: locale.t("codexProtocolProbe.retry"),
      }),
    );
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
