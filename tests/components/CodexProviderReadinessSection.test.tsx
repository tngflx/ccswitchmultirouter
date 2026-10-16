import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexProviderReadinessSection } from "@/components/providers/forms/CodexProviderReadinessSection";
import type {
  CodexProtocolCompatibilityRecord,
  CodexProtocolProbeReadiness,
  CodexProviderAdaptationView,
} from "@/lib/api/protocol-compatibility";
import type { CodexCatalogModel, Provider } from "@/types";

function declaredModel(model = "api-model"): CodexCatalogModel {
  return {
    model,
    upstreamModel: model,
    protocolCapability: {
      schemaVersion: 1,
      source: "provider_api",
      baseUrl: "https://provider.example/v1",
      upstreamModel: model,
      supportedEndpoints: ["openai_chat"],
      supportsTools: true,
      supportsStreaming: true,
      supportsToolContinuation: true,
    },
  };
}

function declaredProvider(
  models: CodexCatalogModel[],
  baseUrl = "https://provider.example/v1",
): Pick<Provider, "settingsConfig" | "meta"> {
  return {
    settingsConfig: { base_url: baseUrl, modelCatalog: { models } },
    meta: { apiFormat: "openai_chat" },
  };
}

function probeEvidence(
  model: string,
  readiness: CodexProtocolProbeReadiness = "verified",
): CodexProtocolCompatibilityRecord {
  return {
    probeVersion: 1,
    target: {
      provider_id: "provider",
      route_id: null,
      public_model: model,
      upstream_model: model,
      transport: "open_ai_chat",
      endpoint_fingerprint: "endpoint",
      authentication_kind: "bearer",
      credential_fingerprint: "redacted-fingerprint",
      request_policy_fingerprint: "policy",
    },
    result: {
      selected_transport: readiness === "verified" ? "open_ai_chat" : null,
      readiness,
      branches: [],
    },
    testedAt: Math.floor(Date.now() / 1000) - 60,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function mixedAdaptation(
  apiReadiness: CodexProtocolProbeReadiness = "unverified",
  apiRecord: CodexProtocolCompatibilityRecord | null = null,
): CodexProviderAdaptationView {
  return {
    persistence: "single",
    status: "partial",
    effectiveTransport: "open_ai_chat",
    testedAt: Math.floor(Date.now() / 1000) - 60,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    models: [
      {
        publicModel: "api-model",
        upstreamModel: "api-model",
        choice: "follow_auto",
        choiceSource: "automatic",
        effectiveTransport: "open_ai_chat",
        resolutionSource: "provider_api",
        readiness: apiReadiness,
        responses: null,
        chat: apiRecord,
      },
      {
        publicModel: "probe-model",
        upstreamModel: "probe-model",
        choice: "follow_auto",
        choiceSource: "automatic",
        effectiveTransport: "open_ai_chat",
        resolutionSource: "probe",
        readiness: "verified",
        responses: null,
        chat: probeEvidence("probe-model"),
      },
    ],
  };
}

describe("CodexProviderReadinessSection", () => {
  it("keeps model synchronization and connection validation in the main flow", () => {
    const onSyncModels = vi.fn();
    const onValidateConnection = vi.fn();

    render(
      <CodexProviderReadinessSection
        models={[]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={onSyncModels}
        onValidateConnection={onValidateConnection}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Models and compatibility" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Readiness")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sync models" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sync models" }));
    expect(screen.getByText("Deep compatibility probe")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Validate connection" }),
    );

    expect(onSyncModels).toHaveBeenCalledTimes(1);
    expect(onValidateConnection).toHaveBeenCalledTimes(1);
  });

  it("offers the confirmed-free catalog action after a live fetch", () => {
    const onUseFreeModelsOnly = vi.fn();
    render(
      <CodexProviderReadinessSection
        models={[{ model: "free-model" }, { model: "paid-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        confirmedFreeModelCount={1}
        canUseFreeModelsOnly
        onUseFreeModelsOnly={onUseFreeModelsOnly}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Use free models only/ }),
    );
    expect(onUseFreeModelsOnly).toHaveBeenCalledOnce();
  });

  it("offers a read-only entry for persisted Responses and Chat evidence", () => {
    const onViewCompatibilityDetails = vi.fn();
    const record = {
      probeVersion: 1,
      target: {
        provider_id: "qwen",
        route_id: null,
        public_model: "qwen3.8",
        upstream_model: "qwen3.8",
        transport: "open_ai_chat" as const,
        endpoint_fingerprint: "endpoint",
        authentication_kind: "bearer",
        credential_fingerprint: "credential",
        request_policy_fingerprint: "policy",
      },
      result: {
        selected_transport: "open_ai_chat" as const,
        readiness: "verified" as const,
        branches: [],
      },
      testedAt: 1_787_875_200,
      expiresAt: 1_787_961_600,
    };

    render(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        apiFormat="openai_chat"
        adaptation={{
          persistence: "single",
          status: "ready",
          effectiveTransport: "open_ai_chat",
          models: [
            {
              publicModel: "qwen3.8",
              upstreamModel: "qwen3.8",
              choice: "follow_auto",
              choiceSource: "automatic",
              effectiveTransport: "open_ai_chat",
              readiness: "verified",
              responses: null,
              chat: record,
            },
          ],
        }}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
        onViewCompatibilityDetails={onViewCompatibilityDetails}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "View saved probe details" }),
    );
    expect(onViewCompatibilityDetails).toHaveBeenCalledOnce();
  });

  it("keeps maintained metadata ownership visible without treating unverified credentials as ready", () => {
    const { rerender } = render(
      <CodexProviderReadinessSection
        models={[{ model: "deepseek-v4-flash" }, { model: "deepseek-v4-pro" }]}
        defaultModel="deepseek-v4-flash"
        apiFormat="openai_responses"
        isMaintainedPreset
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Maintained by CCSwitchMulti")).toBeInTheDocument();
    expect(
      screen.getByText("Validate the connection first"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
    expect(screen.getByText("deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.queryByText("请选择上游协议")).not.toBeInTheDocument();

    rerender(
      <CodexProviderReadinessSection
        models={[{ model: "deepseek-v4-flash" }, { model: "deepseek-v4-pro" }]}
        defaultModel="deepseek-v4-flash"
        apiFormat="openai_responses"
        isMaintainedPreset
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Current credentials and endpoint validated"
        validationTone="success"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Ready for MultiRouter")).toBeInTheDocument();
  });

  it("explains automatic protocol detection for custom providers", () => {
    render(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /Deep probing is needed when capability data is missing or incomplete/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Validate the connection first"),
    ).toBeInTheDocument();
  });

  it("restores API-declared readiness without claiming a successful live probe", () => {
    const models = [declaredModel()];
    const onValidateConnection = vi.fn();
    render(
      <CodexProviderReadinessSection
        models={models}
        provider={declaredProvider(models)}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={onValidateConnection}
      />,
    );

    expect(screen.getByText("Ready for MultiRouter")).toBeInTheDocument();
    expect(screen.getByText("API-declared: 1 model(s)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "API-declared capabilities; credentials and live tool transactions have not been verified.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Live probe verified")).not.toBeInTheDocument();
    expect(onValidateConnection).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Validate connection" }),
    ).toBeEnabled();
  });

  it("combines API-declared models and verified models without requiring every model to be probed", () => {
    const models = [declaredModel(), { model: "probe-model" }];
    render(
      <CodexProviderReadinessSection
        models={models}
        provider={declaredProvider(models)}
        apiFormat="openai_chat"
        adaptation={mixedAdaptation()}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Ready for MultiRouter")).toBeInTheDocument();
    expect(screen.queryByText("Live probe verified")).not.toBeInTheDocument();
  });

  it.each(["partial", "unverified"] as const)(
    "does not let API declarations hide current %s probe evidence",
    (readiness) => {
      const models = [declaredModel(), { model: "probe-model" }];
      render(
        <CodexProviderReadinessSection
          models={models}
          provider={declaredProvider(models)}
          apiFormat="openai_chat"
          adaptation={mixedAdaptation(
            readiness,
            probeEvidence("api-model", readiness),
          )}
          isMaintainedPreset={false}
          isSyncingModels={false}
          isValidatingConnection={false}
          onSyncModels={vi.fn()}
          onValidateConnection={vi.fn()}
        />,
      );

      expect(
        screen.queryByText("Ready for MultiRouter"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Validate the connection first"),
      ).toBeInTheDocument();
    },
  );

  it("does not trust an API declaration after the endpoint changes", () => {
    const models = [declaredModel()];
    render(
      <CodexProviderReadinessSection
        models={models}
        provider={declaredProvider(models, "https://other.example/v1")}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
    expect(
      screen.queryByText("API-declared: 1 model(s)"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Validate the connection first"),
    ).toBeInTheDocument();
  });

  it("requires capabilities for every enabled model but ignores excluded inventory", () => {
    const declared = declaredModel();
    const unknown = { model: "unknown-model" };
    const models = [declared, unknown];
    const props = {
      apiFormat: "openai_chat" as const,
      isMaintainedPreset: false,
      isSyncingModels: false,
      isValidatingConnection: false,
      onSyncModels: vi.fn(),
      onValidateConnection: vi.fn(),
    };
    const { rerender } = render(
      <CodexProviderReadinessSection
        {...props}
        models={models}
        provider={declaredProvider(models)}
      />,
    );

    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
    const enabledOnly = [declared, { ...unknown, enabled: false }];
    rerender(
      <CodexProviderReadinessSection
        {...props}
        models={enabledOnly}
        provider={declaredProvider(enabledOnly)}
      />,
    );
    expect(screen.getByText("Ready for MultiRouter")).toBeInTheDocument();

    const excluded = enabledOnly.map((model) => ({ ...model, enabled: false }));
    rerender(
      <CodexProviderReadinessSection
        {...props}
        models={excluded}
        provider={declaredProvider(excluded)}
      />,
    );
    expect(screen.getByText("Enable a model")).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
    expect(
      screen.queryByText("API-declared: 1 model(s)"),
    ).not.toBeInTheDocument();
  });

  it("keeps a current live validation failure visible despite API declarations", () => {
    const models = [declaredModel()];
    render(
      <CodexProviderReadinessSection
        models={models}
        provider={declaredProvider(models)}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationTone="error"
        validationSummary="Current endpoint unavailable"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Connection validation failed"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Current endpoint unavailable",
    );
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
  });

  it("shows an explicit manual protocol instead of a conflicting API declaration", () => {
    const models = [declaredModel()];
    const provider = declaredProvider(models);
    render(
      <CodexProviderReadinessSection
        models={models}
        provider={{
          ...provider,
          meta: {
            ...provider.meta,
            codexProtocolOverrides: { "api-model": "openai_responses" },
          },
        }}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    const protocol = within(
      screen.getByText("Effective protocol").parentElement!,
    );
    expect(protocol.getByText("Responses")).toBeInTheDocument();
    expect(protocol.queryByText("Chat")).not.toBeInTheDocument();
    expect(screen.getByText("API-declared: 1 model(s)")).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
  });

  it("restores ready state from persisted protocol adaptation evidence", () => {
    render(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        defaultModel="qwen3.8"
        apiFormat="openai_chat"
        adaptation={{
          persistence: "single",
          status: "ready",
          effectiveTransport: "open_ai_chat",
          testedAt: Math.floor(Date.now() / 1000) - 60,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          models: [],
        }}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Ready for MultiRouter")).toBeInTheDocument();
    expect(
      screen.queryByText("Validate the connection first"),
    ).not.toBeInTheDocument();
  });

  it("does not let stale evidence hide a current validation failure", () => {
    const readyAdaptation = {
      persistence: "single" as const,
      status: "ready" as const,
      effectiveTransport: "open_ai_chat" as const,
      testedAt: Math.floor(Date.now() / 1000) - 60,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      models: [],
    };
    const { rerender } = render(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        apiFormat="openai_chat"
        adaptation={{ ...readyAdaptation, status: "stale" }}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Validate the connection first"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();

    rerender(
      <CodexProviderReadinessSection
        models={[{ model: "qwen3.8" }]}
        apiFormat="openai_chat"
        adaptation={readyAdaptation}
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Current endpoint unavailable"
        validationTone="error"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Connection validation failed"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ready for MultiRouter")).not.toBeInTheDocument();
  });

  it("distinguishes an all-disabled catalog from usable probe models", () => {
    const onValidateConnection = vi.fn();
    render(
      <CodexProviderReadinessSection
        models={[{ model: "disabled-model", enabled: false }]}
        defaultModel="disabled-model"
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        onSyncModels={vi.fn()}
        onValidateConnection={onValidateConnection}
      />,
    );

    expect(screen.getByText("0 enabled, 1 disabled")).toBeInTheDocument();
    expect(screen.getByText("Enable a model")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Validate connection" }),
    );
    expect(onValidateConnection).toHaveBeenCalledOnce();
  });

  it("uses accessible live regions for validation results", () => {
    const { rerender } = render(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Responses and Chat are both unavailable"
        validationTone="error"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Responses and Chat are both unavailable",
    );

    rerender(
      <CodexProviderReadinessSection
        models={[{ model: "private-model" }]}
        apiFormat="openai_chat"
        isMaintainedPreset={false}
        isSyncingModels={false}
        isValidatingConnection={false}
        validationSummary="Chat validation passed"
        validationTone="success"
        onSyncModels={vi.fn()}
        onValidateConnection={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Chat validation passed",
    );
  });
});
