import { describe, expect, it } from "vitest";
import {
  buildWizardPageSequence,
  canEnterWizardPage,
  requiredWizardPrerequisite,
  type WizardFlowContext,
} from "./codexMultiRouterWizardFlow";

const readyContext: WizardFlowContext = {
  providerCount: 2,
  selectedSourceCount: 1,
  allSelectedSourcesReady: true,
  catalogPrepared: true,
  protocolProbeComplete: true,
  hasVisibleModels: true,
  planSaved: false,
  planEnabled: false,
  acceptanceStatus: "waiting",
};

describe("Codex MultiRouter guided flow", () => {
  it("inserts first-provider when the Codex provider inventory is empty", () => {
    expect(
      buildWizardPageSequence({
        ...readyContext,
        providerCount: 0,
        selectedSourceCount: 0,
        allSelectedSourcesReady: false,
        catalogPrepared: false,
        protocolProbeComplete: false,
        hasVisibleModels: false,
      }),
    ).toEqual([
      "welcome",
      "inventory",
      "first-provider",
      "readiness",
      "sources",
      "catalog",
      "protocol",
      "models",
      "model-order",
      "reasoning",
      "subagents-tools",
      "routing-review",
      "save-enable",
      "acceptance",
    ]);
  });

  it("omits first-provider when at least one Provider exists", () => {
    expect(buildWizardPageSequence(readyContext)).toEqual([
      "welcome",
      "inventory",
      "readiness",
      "sources",
      "catalog",
      "protocol",
      "models",
      "model-order",
      "reasoning",
      "subagents-tools",
      "routing-review",
      "save-enable",
      "acceptance",
    ]);
  });

  it("gates later pages on their real prerequisites", () => {
    const empty: WizardFlowContext = {
      ...readyContext,
      providerCount: 0,
      selectedSourceCount: 0,
      allSelectedSourcesReady: false,
      catalogPrepared: false,
      protocolProbeComplete: false,
      hasVisibleModels: false,
    };
    expect(canEnterWizardPage("first-provider", empty)).toBe(true);
    expect(canEnterWizardPage("catalog", empty)).toBe(false);
    expect(canEnterWizardPage("protocol", empty)).toBe(false);
    expect(canEnterWizardPage("models", empty)).toBe(false);
    expect(canEnterWizardPage("routing-review", empty)).toBe(false);
    expect(canEnterWizardPage("acceptance", empty)).toBe(false);

    expect(canEnterWizardPage("catalog", readyContext)).toBe(true);
    expect(canEnterWizardPage("protocol", readyContext)).toBe(true);
    expect(canEnterWizardPage("routing-review", readyContext)).toBe(true);
    expect(canEnterWizardPage("acceptance", readyContext)).toBe(false);
    expect(
      canEnterWizardPage("acceptance", {
        ...readyContext,
        planSaved: true,
        planEnabled: true,
      }),
    ).toBe(true);
  });

  it("identifies the prerequisite that makes a preview page read-only", () => {
    expect(
      requiredWizardPrerequisite("reasoning", {
        ...readyContext,
        protocolProbeComplete: false,
      }),
    ).toBe("protocol");
    expect(
      requiredWizardPrerequisite("reasoning", {
        ...readyContext,
        selectedSourceCount: 0,
        allSelectedSourcesReady: false,
        catalogPrepared: false,
        protocolProbeComplete: false,
        hasVisibleModels: false,
      }),
    ).toBe("sources");
    expect(requiredWizardPrerequisite("reasoning", readyContext)).toBeNull();
  });

  it("keeps the model selection page editable when every model is deselected", () => {
    const noModelsKept: WizardFlowContext = {
      ...readyContext,
      hasVisibleModels: false,
    };

    expect(canEnterWizardPage("models", noModelsKept)).toBe(true);
    expect(requiredWizardPrerequisite("models", noModelsKept)).toBeNull();
    expect(
      canEnterWizardPage("models", {
        ...noModelsKept,
        selectedSourceCount: 0,
        allSelectedSourcesReady: false,
      }),
    ).toBe(false);
    expect(
      requiredWizardPrerequisite("models", {
        ...noModelsKept,
        selectedSourceCount: 0,
        allSelectedSourcesReady: false,
      }),
    ).toBe("sources");
    expect(canEnterWizardPage("model-order", noModelsKept)).toBe(false);
    expect(requiredWizardPrerequisite("model-order", noModelsKept)).toBe(
      "catalog",
    );
  });

  it("blocks route pages when the catalog only contains disabled recovery rows", () => {
    const disabledOnly: WizardFlowContext = {
      ...readyContext,
      hasVisibleModels: false,
    };

    expect(canEnterWizardPage("models", disabledOnly)).toBe(true);
    expect(canEnterWizardPage("model-order", disabledOnly)).toBe(false);
    expect(canEnterWizardPage("routing-review", disabledOnly)).toBe(false);
    expect(requiredWizardPrerequisite("routing-review", disabledOnly)).toBe(
      "catalog",
    );
  });
});
