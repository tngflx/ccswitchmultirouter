import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  CodexProtocolProbeProgressEvent,
  CodexProviderProtocolPreflightOutcome,
} from "@/lib/api/protocol-compatibility";
import { CodexProtocolProbeProgressDialog } from "./CodexProtocolProbeProgressDialog";

describe("CodexProtocolProbeProgressDialog", () => {
  it("aggregates the completed models across every provider batch", () => {
    const events: CodexProtocolProbeProgressEvent[] = [
      {
        kind: "candidate_finished",
        model: "qwen3.8",
        selectedTransport: "open_ai_chat",
        readiness: "verified",
      },
      {
        kind: "batch_finished",
        total: 1,
        verified: 1,
        partial: 0,
        failed: 0,
      },
      {
        kind: "candidate_finished",
        model: "glm-5.3",
        selectedTransport: "open_ai_chat",
        readiness: "partial",
      },
      {
        kind: "batch_finished",
        total: 1,
        verified: 0,
        partial: 1,
        failed: 0,
      },
    ];

    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["qwen3.8", "glm-5.3"]}
        events={events}
        outcome={null}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Completed 2 models: Verified 1, Partial 1, Failed 0."),
    ).toBeInTheDocument();
  });

  it("keeps duplicate public model names distinct across provider batches", () => {
    const expectedTargets = [
      {
        providerId: "kimi-responses",
        providerName: "Kimi Responses",
        model: "k3",
      },
      {
        providerId: "kimi-chat",
        providerName: "Kimi Chat",
        model: "k3",
      },
    ];
    const events: Array<
      CodexProtocolProbeProgressEvent & {
        providerId: string;
        providerName: string;
      }
    > = [
      {
        kind: "candidate_finished",
        providerId: "kimi-responses",
        providerName: "Kimi Responses",
        model: "k3",
        selectedTransport: "open_ai_chat",
        readiness: "verified",
      },
      {
        kind: "batch_finished",
        providerId: "kimi-responses",
        providerName: "Kimi Responses",
        total: 1,
        verified: 1,
        partial: 0,
        failed: 0,
      },
      {
        kind: "candidate_finished",
        providerId: "kimi-chat",
        providerName: "Kimi Chat",
        model: "k3",
        selectedTransport: "open_ai_chat",
        readiness: "verified",
      },
      {
        kind: "batch_finished",
        providerId: "kimi-chat",
        providerName: "Kimi Chat",
        total: 1,
        verified: 1,
        partial: 0,
        failed: 0,
      },
    ];

    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["k3", "k3"]}
        {...{ expectedTargets }}
        events={events}
        outcome={null}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Completed 2 models: Verified 2, Partial 0, Failed 0."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText("Kimi Responses")).toBeInTheDocument();
    expect(screen.getByText("Kimi Chat")).toBeInTheDocument();
  });

  it("lets a verified alternate branch become the manual model selection", () => {
    const onSelectTransport = vi.fn();
    const verifiedBranch = {
      assessment: {
        transport: "open_ai_responses",
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
    };
    const outcome = {
      provider: { id: "provider", name: "Qwen", settingsConfig: {} },
      adaptationPreview: {
        persistence: "single",
        status: "ready",
        effectiveTransport: "open_ai_responses",
        models: [],
      },
      receiptIds: ["receipt-qwen"],
      protocolApplied: true,
      probeUsage: undefined,
      observations: [],
      records: [
        {
          probeVersion: 6,
          target: {
            provider_id: "provider",
            route_id: null,
            public_model: "qwen3.8",
            upstream_model: "qwen3.8",
            transport: "open_ai_responses",
            endpoint_fingerprint: "endpoint",
            authentication_kind: "bearer",
            credential_fingerprint: "credential",
            request_policy_fingerprint: "policy",
          },
          result: {
            selected_transport: "open_ai_responses",
            readiness: "verified",
            branches: [
              verifiedBranch,
              {
                ...verifiedBranch,
                assessment: {
                  ...verifiedBranch.assessment,
                  transport: "open_ai_chat",
                },
              },
            ],
          },
          testedAt: 1,
          expiresAt: 2,
        },
      ],
    } as CodexProviderProtocolPreflightOutcome;

    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["qwen3.8"]}
        events={[]}
        outcome={outcome}
        error=""
        onOpenChange={vi.fn()}
        onSelectTransport={onSelectTransport}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "qwen3.8 Select Chat Completions",
      }),
    );

    expect(onSelectTransport).toHaveBeenCalledWith({
      model: "qwen3.8",
      providerId: null,
      transport: "open_ai_chat",
      readiness: "verified",
    });
  });

  it("allows a partial branch as an explicit manual selection and names its exact gaps", () => {
    const onSelectTransport = vi.fn();
    const outcome = {
      provider: { id: "provider", name: "Relay", settingsConfig: {} },
      adaptationPreview: {
        persistence: "single",
        status: "ready",
        effectiveTransport: null,
        models: [],
      },
      receiptIds: ["receipt-partial"],
      protocolApplied: false,
      observations: [],
      records: [
        {
          probeVersion: 9,
          target: {
            provider_id: "provider",
            route_id: null,
            public_model: "partial-model",
            upstream_model: "partial-model",
            transport: "open_ai_chat",
            endpoint_fingerprint: "endpoint",
            authentication_kind: "bearer",
            credential_fingerprint: "credential",
            request_policy_fingerprint: "policy",
          },
          result: {
            selected_transport: "open_ai_chat",
            readiness: "partial",
            branches: [
              {
                assessment: {
                  transport: "open_ai_chat",
                  baseline: "passed",
                  streaming: "passed",
                  forced_tool: "passed",
                  continuation: "unsupported",
                },
                reasoning_shape: {
                  semantic: "none",
                  source: "none",
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
        },
      ],
    } as CodexProviderProtocolPreflightOutcome;

    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["partial-model"]}
        events={[]}
        outcome={outcome}
        error=""
        onOpenChange={vi.fn()}
        onSelectTransport={onSelectTransport}
      />,
    );

    expect(
      screen.getByText(/Tool continuation: Unsupported/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Reasoning content: Not returned/),
    ).toBeInTheDocument();
    const chatBranch = screen
      .getByText("Chat Completions")
      .closest("section") as HTMLElement;
    const selectButton = within(chatBranch).getByRole("button", {
      name: "partial-model Use anyway Chat Completions",
    });
    expect(selectButton).toHaveAttribute("aria-pressed", "false");
    expect(onSelectTransport).not.toHaveBeenCalled();
    fireEvent.click(selectButton);
    expect(onSelectTransport).toHaveBeenCalledWith({
      model: "partial-model",
      providerId: null,
      transport: "open_ai_chat",
      readiness: "partial",
    });
  });

  it("shows the verified tool schema and history replay strategy for each branch", () => {
    const outcome = {
      provider: {
        id: "provider",
        name: "Kimi",
        settingsConfig: {},
      },
      adaptationPreview: {
        persistence: "single",
        status: "ready",
        effectiveTransport: "open_ai_chat",
        models: [],
      },
      receiptIds: ["receipt-kimi-k2"],
      protocolApplied: true,
      probeUsage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
        totalTokens: 1500,
        reportedResponses: 8,
        successfulResponses: 10,
        estimatedCostUsd: "0.0123",
        pricedModels: ["kimi-k2"],
        unpricedModels: [],
      },
      observations: [],
      records: [
        {
          probeVersion: 3,
          target: {
            provider_id: "provider",
            route_id: null,
            public_model: "kimi-k2",
            upstream_model: "kimi-k2",
            transport: "open_ai_responses",
            endpoint_fingerprint: "endpoint",
            authentication_kind: "bearer",
            credential_fingerprint: "credential",
            request_policy_fingerprint: "policy",
          },
          result: {
            selected_transport: "open_ai_responses",
            readiness: "verified",
            branches: [
              {
                assessment: {
                  transport: "open_ai_responses",
                  baseline: "passed",
                  streaming: "passed",
                  forced_tool: "passed",
                  continuation: "passed",
                },
                reasoning_shape: {
                  semantic: "summary",
                  source: "native_responses",
                  pre_tool_visible_content: "absent",
                },
                tool_schema_dialect: "moonshot_mfjs",
                tool_schema_evidence: "ambiguous_rejection",
                adaptations: [
                  {
                    trigger: "ambiguous_request_rejection",
                    change: "tool_schema_moonshot_mfjs",
                    outcome: "verified",
                  },
                ],
                history_replay: "responses_reasoning_text_content",
                failures: [],
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
                tool_schema_dialect: "moonshot_mfjs",
                history_replay: "chat_reasoning_content",
                failures: [],
              },
            ],
          },
          testedAt: 1,
          expiresAt: 2,
        },
      ],
    } as CodexProviderProtocolPreflightOutcome;

    const { rerender } = render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["kimi-k2"]}
        events={[]}
        outcome={outcome}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Tool schema:Moonshot MFJS (fully verified after ambiguous rejection)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Upstream returned 400\/422 without identifying an incompatible field/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Re-request after compiling the dynamic OpenAI tool schema into the compatible MFJS object shape/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Full re-test passed/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Tool schema:Moonshot MFJS (no source; not applied automatically)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("History continuation:reasoning_text content"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("History continuation:reasoning_content"),
    ).toBeInTheDocument();
    expect(screen.getByText("Native upstream summary")).toBeInTheDocument();
    expect(screen.getByText("Raw reasoning text")).toBeInTheDocument();
    expect(screen.getAllByText("Passed after adaptation")).toHaveLength(2);
    expect(
      screen.getByText(/The upstream returned reasoning_content/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /The default tool request was rejected or returned no valid tool call/,
      ),
    ).toHaveLength(2);
    expect(
      screen.getByText(/The native reasoning-history shape was rejected/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The upstream reported 1,500 tokens/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Estimated cost is about US\$0\.0123/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Reported numeric usage is saved with this Responses\/Chat dual-protocol evidence/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 successful responses returned no usage/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Runtime adaptation: keep Responses requests in the native protocol; rebuild continuation reasoning as reasoning_text content.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Runtime adaptation: convert Codex Responses to Chat Completions; read reasoning from reasoning_content and project it back to Codex.",
      ),
    ).toBeInTheDocument();

    const chatBranch = screen
      .getByText("Chat Completions")
      .closest("section") as HTMLElement;
    fireEvent.click(
      within(chatBranch).getByRole("button", {
        name: "View field mappings and runtime behavior",
      }),
    );
    expect(
      within(chatBranch).getByText("Codex input[] → Chat messages[]"),
    ).toBeInTheDocument();
    expect(
      within(chatBranch).getByText(
        "function_call_output → role=tool + tool_call_id",
      ),
    ).toBeInTheDocument();
    expect(
      within(chatBranch).getByText(
        "choices[].delta.reasoning_content → response.reasoning_text.delta",
      ),
    ).toBeInTheDocument();
    expect(
      within(chatBranch).getByText(
        "After saving and enabling the provider, mappings are applied automatically to each request; running a probe alone does not rewrite the current configuration.",
      ),
    ).toBeInTheDocument();

    const responsesBranch = screen
      .getByText("Responses")
      .closest("section") as HTMLElement;
    fireEvent.click(
      within(responsesBranch).getByRole("button", {
        name: "View field mappings and runtime behavior",
      }),
    );
    expect(
      within(responsesBranch).getByText(
        "reasoning.content / readable summary → content[type=reasoning_text]; summary=[]",
      ),
    ).toBeInTheDocument();
    expect(
      within(responsesBranch).getByText(
        "Tool calls and outputs keep the native Responses structure",
      ),
    ).toBeInTheDocument();
    rerender(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["kimi-k2"]}
        events={[]}
        outcome={null}
        storedRecords={outcome.records}
        error=""
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Passed after adaptation")).toHaveLength(2);
    for (const running of [true, false]) {
      rerender(
        <CodexProtocolProbeProgressDialog
          open
          running={running}
          expectedModels={["kimi-k2"]}
          events={[]}
          outcome={null}
          storedRecords={outcome.records}
          error={running ? "" : "本轮请求失败"}
          onOpenChange={vi.fn()}
        />,
      );
      expect(screen.queryAllByText("Passed after adaptation")).toHaveLength(0);
      expect(screen.queryAllByText("Verified", { exact: true })).toHaveLength(
        0,
      );
    }
  });

  it("warns before completion that deep probing sends billable model requests", () => {
    render(
      <CodexProtocolProbeProgressDialog
        open
        running
        expectedModels={["qwen3.8"]}
        events={[]}
        outcome={null}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /The deep probe sends multiple real requests to each model’s Responses and Chat endpoints. This consumes tokens and may incur charges/,
      ),
    ).toBeInTheDocument();
  });

  it("shows a real repair attempt as pending and does not promote a failed retry", () => {
    const events: CodexProtocolProbeProgressEvent[] = [
      {
        kind: "compatibility_retry",
        model: "glm-test",
        transport: "open_ai_responses",
        stage: "continuation",
        rule: "omit_reasoning",
        trigger: "adapted_replay_rejection",
        change: "omit_incompatible_reasoning",
      },
    ];
    const props = {
      open: true,
      running: true,
      expectedModels: ["glm-test"],
      events,
      outcome: null,
      error: "",
      onOpenChange: vi.fn(),
    };
    const { rerender } = render(
      <CodexProtocolProbeProgressDialog {...props} />,
    );
    expect(
      screen.getByText("Automatically adapting and retrying"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /removed only reasoning items while keeping tool calls and results/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Passed after adaptation"),
    ).not.toBeInTheDocument();
    rerender(
      <CodexProtocolProbeProgressDialog
        {...props}
        running={false}
        events={[
          ...events,
          {
            kind: "branch_finished",
            model: "glm-test",
            transport: "open_ai_responses",
            readiness: "partial",
          },
        ]}
      />,
    );
    expect(screen.getByText("Adaptation did not pass")).toBeInTheDocument();
    expect(
      screen.queryByText("Automatically adapting and retrying"),
    ).not.toBeInTheDocument();
  });

  it("aggregates reported token usage and mappings across provider outcomes", () => {
    const makeOutcome = (
      providerId: string,
      model: string,
      totalTokens: number,
      estimatedCostUsd: string,
    ) =>
      ({
        provider: {
          id: providerId,
          name: providerId,
          settingsConfig: {},
        },
        adaptationPreview: {
          persistence: "single",
          status: "ready",
          effectiveTransport: "open_ai_responses",
          models: [],
        },
        receiptIds: [`receipt-${providerId}`],
        protocolApplied: true,
        probeUsage: {
          inputTokens: totalTokens - 10,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens,
          reportedResponses: 1,
          successfulResponses: 1,
          estimatedCostUsd,
          pricedModels: [model],
          unpricedModels: [],
        },
        observations: [],
        records: [
          {
            probeVersion: 6,
            target: {
              provider_id: providerId,
              route_id: null,
              public_model: model,
              upstream_model: model,
              transport: "open_ai_responses",
              endpoint_fingerprint: `endpoint-${providerId}`,
              authentication_kind: "bearer",
              credential_fingerprint: `credential-${providerId}`,
              request_policy_fingerprint: `policy-${providerId}`,
            },
            result: {
              selected_transport: "open_ai_responses",
              readiness: "verified",
              branches: [
                {
                  assessment: {
                    transport: "open_ai_responses",
                    baseline: "passed",
                    streaming: "passed",
                    forced_tool: "passed",
                    continuation: "passed",
                  },
                  reasoning_shape: {
                    semantic: "summary",
                    source: "native_responses",
                    pre_tool_visible_content: "absent",
                  },
                  tool_schema_dialect: "openai",
                  history_replay: "native_only",
                  failures: [],
                },
              ],
            },
            testedAt: 1,
            expiresAt: 2,
          },
        ],
      }) as CodexProviderProtocolPreflightOutcome;

    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["qwen3.8", "glm-5.3"]}
        expectedTargets={[
          {
            providerId: "qwen-provider",
            providerName: "qwen-provider",
            model: "qwen3.8",
          },
          {
            providerId: "glm-provider",
            providerName: "glm-provider",
            model: "glm-5.3",
          },
        ]}
        events={[]}
        outcome={null}
        outcomes={[
          makeOutcome("qwen-provider", "qwen3.8", 100, "0.001"),
          makeOutcome("glm-provider", "glm-5.3", 200, "0.002"),
        ]}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/The upstream reported 300 tokens/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Estimated cost is about US\$0\.003/),
    ).toBeInTheDocument();
    expect(screen.getByText("qwen3.8")).toBeInTheDocument();
    expect(screen.getByText("glm-5.3")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "Runtime adaptation: keep Responses requests in the native protocol and replay native upstream reasoning items unchanged.",
      ),
    ).toHaveLength(2);
  });

  it("marks opaque reasoning as unavailable for Codex presentation", () => {
    const outcome = {
      provider: {
        id: "provider",
        name: "Opaque gateway",
        settingsConfig: {},
      },
      adaptationPreview: {
        persistence: "single",
        status: "ready",
        effectiveTransport: "open_ai_chat",
        models: [],
      },
      receiptIds: ["receipt-opaque-model"],
      protocolApplied: false,
      observations: [],
      records: [
        {
          probeVersion: 6,
          target: {
            provider_id: "provider",
            route_id: null,
            public_model: "opaque-model",
            upstream_model: "opaque-model",
            transport: "open_ai_responses",
            endpoint_fingerprint: "endpoint",
            authentication_kind: "bearer",
            credential_fingerprint: "credential",
            request_policy_fingerprint: "policy",
          },
          result: {
            selected_transport: "open_ai_responses",
            readiness: "verified",
            branches: [
              {
                assessment: {
                  transport: "open_ai_responses",
                  baseline: "passed",
                  streaming: "passed",
                  forced_tool: "passed",
                  continuation: "passed",
                },
                reasoning_shape: {
                  semantic: "opaque",
                  source: "native_responses",
                  pre_tool_visible_content: "absent",
                },
                tool_schema_dialect: "openai",
                history_replay: "native_only",
                failures: [],
              },
            ],
          },
          testedAt: 1,
          expiresAt: 2,
        },
      ],
    } as CodexProviderProtocolPreflightOutcome;

    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["opaque-model"]}
        events={[]}
        outcome={outcome}
        error=""
        onOpenChange={vi.fn()}
      />,
    );

    const responses = screen.getByText("Responses").closest("section");
    expect(responses).not.toBeNull();
    const reasoningRow = within(responses as HTMLElement)
      .getByText("Reasoning content")
      .closest("div");
    expect(reasoningRow).not.toBeNull();
    expect(
      within(reasoningRow as HTMLElement).getByText(
        "Encrypted/opaque (not displayable by Codex)",
      ),
    ).toBeInTheDocument();
    expect(
      within(reasoningRow as HTMLElement).getByText("Unsupported"),
    ).toBeInTheDocument();
  });

  it("renders live stage progress and prevents closing while a probe is running", () => {
    const onOpenChange = vi.fn();
    const events = [
      {
        kind: "stage_started",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "baseline",
      },
      {
        kind: "stage_finished",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "baseline",
        stageStatus: "passed",
      },
      {
        kind: "stage_started",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "streaming",
      },
    ] as CodexProtocolProbeProgressEvent[];

    render(
      <CodexProtocolProbeProgressDialog
        open
        running
        expectedModels={["qwen3.8"]}
        events={events}
        outcome={null}
        error=""
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByText(/Validating models 0\/1/)).toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Probe running" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Probe again" })).toBeNull();
  });

  it("shows unavailable as not detected and offers an explicit retry", () => {
    const onRetry = vi.fn();
    const events = [
      {
        kind: "stage_finished",
        model: "qwen3.8",
        transport: "open_ai_responses",
        stage: "baseline",
        stageStatus: "failed",
        failure: {
          stage: "baseline",
          kind: "http_status",
          status_code: 521,
        },
      },
      {
        kind: "reasoning_classified",
        model: "qwen3.8",
        transport: "open_ai_responses",
        reasoningSemantic: "none",
        reasoningSource: "none",
      },
    ] as CodexProtocolProbeProgressEvent[];

    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["qwen3.8"]}
        events={events}
        outcome={null}
        error=""
        onOpenChange={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(
      screen.getByText("HTTP 521 · Upstream unreachable"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Probe again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("never reports 0/0/0 as a completed probe when expected models have no result", () => {
    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        expectedModels={["qwen3.8"]}
        events={[
          {
            kind: "batch_finished",
            total: 0,
            verified: 0,
            partial: 0,
            failed: 0,
          },
        ]}
        outcome={null}
        error="后端没有返回已启用模型 qwen3.8 的探测结果"
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(
        "Completed 0 models: Verified 0, Partial 0, Failed 0.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Probe incomplete: 1 models have no result."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("No probe result returned")).toHaveLength(2);
  });

  it("describes a missing manual protocol as an unapplied configuration instead of a failed probe", () => {
    render(
      <CodexProtocolProbeProgressDialog
        open
        running={false}
        actionRequired
        expectedModels={["qwen3.8"]}
        events={[]}
        outcome={null}
        error="codex_provider_set_manual_intent_required"
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("No new probe was run; configuration was not applied."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Manual protocol mode is active, but neither Responses nor Chat Completions is selected. Close to skip this application, or choose a protocol and save without probing again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Probe incomplete/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Probe interrupted/)).not.toBeInTheDocument();
  });

  it.each([
    [401, "HTTP 401 · Authentication failed"],
    [403, "HTTP 403 · Current credentials are not authorized"],
    [429, "HTTP 429 · Rate limited or insufficient quota"],
    [500, "HTTP 500 · Upstream service error"],
  ])(
    "explains HTTP %s without treating it as protocol support",
    (status, label) => {
      const events = [
        {
          kind: "stage_finished",
          model: "provider-model",
          transport: "open_ai_chat",
          stage: "baseline",
          stageStatus: "failed",
          failure: {
            stage: "baseline",
            kind: "http_status",
            status_code: status,
          },
        },
      ] as CodexProtocolProbeProgressEvent[];

      render(
        <CodexProtocolProbeProgressDialog
          open
          running={false}
          expectedModels={["provider-model"]}
          events={events}
          outcome={null}
          error=""
          onOpenChange={vi.fn()}
        />,
      );

      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );
});
