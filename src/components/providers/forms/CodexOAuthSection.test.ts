import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexOAuthSection,
  codexAccountPoolFacadeLabel,
  codexPoolFacadeRestartMessage,
} from "./CodexOAuthSection";

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  setPolicy: vi.fn(),
  refreshQuota: vi.fn(),
  removeAccount: vi.fn(),
  logout: vi.fn(),
  getProviders: vi.fn(),
  getCurrentProvider: vi.fn(),
}));

vi.mock("./hooks/useCodexOauth", () => ({
  useCodexOauth: () => ({
    accounts: [
      {
        id: "managed",
        login: "managed@example.com",
        avatar_url: null,
      },
      {
        id: "managed-2",
        login: "second@example.com",
        avatar_url: null,
      },
    ],
    defaultAccountId: "managed",
    hasAnyAccount: true,
    pollingState: "idle",
    deviceCode: null,
    error: null,
    authError: null,
    isPolling: false,
    isAddingAccount: false,
    isRemovingAccount: false,
    isSettingDefaultAccount: false,
    addAccount: vi.fn(),
    removeAccount: mocks.removeAccount,
    setDefaultAccount: vi.fn(),
    cancelAuth: vi.fn(),
    logout: mocks.logout,
  }),
}));

vi.mock("@/lib/api/auth", () => ({
  authApi: {
    getCodexAccountPoolPolicy: mocks.getPolicy,
    setCodexAccountPoolPolicy: mocks.setPolicy,
    refreshCodexAccountPoolQuota: mocks.refreshQuota,
  },
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    getAll: mocks.getProviders,
    getCurrent: mocks.getCurrentProvider,
  },
}));

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(CodexOAuthSection),
    ),
  );
}

beforeEach(() => {
  mocks.getPolicy.mockResolvedValue({
    enabled: true,
    desktopAccountId: "managed",
    entries: [
      {
        accountId: "native_codex_auth",
        enabled: true,
        reservePercent: 5,
      },
      { accountId: "managed-2", enabled: true, reservePercent: 5 },
    ],
  });
  mocks.refreshQuota.mockResolvedValue([]);
  mocks.setPolicy.mockResolvedValue({
    applied: true,
    facadeChanged: false,
    codexRestartRequired: false,
    facade: "native_mixed",
  });
  mocks.getCurrentProvider.mockResolvedValue("router");
  mocks.getProviders.mockResolvedValue({
    router: {
      id: "router",
      name: "Codex MultiRouter",
      settingsConfig: {
        codexRouting: {
          routes: [
            {
              id: "official",
              label: "OpenAI Official",
              enabled: true,
              authPolicy: { source: "native_codex_auth" },
            },
            {
              id: "managed",
              label: "Managed fallback",
              enabled: true,
              authPolicy: {
                source: "managed_codex_oauth",
                accountId: "managed-2",
              },
            },
          ],
        },
      },
    },
  });
});

describe("Codex OAuth 账号池认证门面", () => {
  it("在认证中心分开显示 Desktop 登录、CCSM 默认和当前路由认证来源", async () => {
    renderSection();

    await screen.findByRole("spinbutton", {
      name: /managed@example.com.*reserve threshold/,
    });
    expect(
      await screen.findByText("Codex Desktop signed-in account"),
    ).toBeVisible();
    expect(screen.getAllByText("managed@example.com").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("CCSM-managed default account")).toBeVisible();
    expect(
      screen.getByText("Current Codex route authentication source"),
    ).toBeVisible();
    expect(screen.getByText("OpenAI Official")).toBeVisible();
    expect(
      screen.getAllByText(/Desktop signed-in account/).length,
    ).toBeGreaterThan(1);
    expect(screen.getByText("Managed fallback")).toBeVisible();
    expect(screen.getByText(/CCSM-managed: second@example\.com/)).toBeVisible();
  });

  it("仅在账号池启用且 Desktop 项启用时展示混合认证", () => {
    const entries = [
      {
        accountId: "native_codex_auth",
        enabled: true,
        reservePercent: 5,
      },
      { accountId: "managed", enabled: true, reservePercent: 5 },
    ];
    expect(codexAccountPoolFacadeLabel({ enabled: true, entries })).toBe(
      "Desktop / hybrid authentication",
    );
    expect(codexAccountPoolFacadeLabel({ enabled: false, entries })).toBe(
      "CCSM-managed authentication",
    );
    expect(
      codexAccountPoolFacadeLabel({
        enabled: true,
        entries: entries.map((entry) =>
          entry.accountId === "native_codex_auth"
            ? { ...entry, enabled: false }
            : entry,
        ),
      }),
    ).toBe("CCSM-managed authentication");
  });

  it("只有门面发生变化时提示完全重启 Codex", () => {
    expect(
      codexPoolFacadeRestartMessage({
        applied: true,
        facadeChanged: true,
        codexRestartRequired: true,
        facade: "native_mixed",
      }),
    ).toContain("Fully quit and restart Codex");
    expect(
      codexPoolFacadeRestartMessage({
        applied: true,
        facadeChanged: true,
        codexRestartRequired: true,
        facade: "native_mixed",
      }),
    ).not.toContain("current MultiRouter");
    expect(
      codexPoolFacadeRestartMessage({
        applied: true,
        facadeChanged: false,
        codexRestartRequired: false,
        facade: "fully_managed",
      }),
    ).toBeNull();
  });

  it("说明 OpenAI Official 可独立使用账号池且 Router 仅继承设置", async () => {
    renderSection();
    expect(
      await screen.findByText(/does not require MultiRouter/),
    ).toBeVisible();
    expect(
      screen.getByText(
        /official models in MultiRouter inherit the same setting/,
      ),
    ).toBeVisible();
  });

  it("编辑账号池草稿不会并发持久化，点击保存只提交最终值一次", async () => {
    const user = userEvent.setup();
    renderSection();

    const reserveInput = await screen.findByRole("spinbutton", {
      name: /managed@example.com.*reserve threshold/,
    });
    fireEvent.change(reserveInput, { target: { value: "1" } });
    fireEvent.change(reserveInput, { target: { value: "10" } });

    expect(mocks.setPolicy).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Save account-pool settings" }),
    );

    await waitFor(() => expect(mocks.setPolicy).toHaveBeenCalledTimes(1));
    expect(mocks.setPolicy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({
            accountId: "native_codex_auth",
            reservePercent: 10,
          }),
        ]),
      }),
    );
  });

  it("账号池保存进行中禁止再次保存和修改冲突控件", async () => {
    let resolveSave: ((value: unknown) => void) | undefined;
    mocks.setPolicy.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const user = userEvent.setup();
    renderSection();

    const reserveInput = await screen.findByRole("spinbutton", {
      name: /managed@example.com.*reserve threshold/,
    });
    fireEvent.change(reserveInput, { target: { value: "10" } });
    const saveButton = screen.getByRole("button", {
      name: "Save account-pool settings",
    });
    await user.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());
    expect(reserveInput).toBeDisabled();
    expect(
      screen.getByRole("switch", {
        name: "Automatic ChatGPT account switching",
      }),
    ).toBeDisabled();
    screen
      .getAllByTitle("Move up")
      .forEach((button) => expect(button).toBeDisabled());
    screen
      .getAllByTitle("Move down")
      .forEach((button) => expect(button).toBeDisabled());

    resolveSave?.({
      applied: true,
      facadeChanged: false,
      codexRestartRequired: false,
      facade: "native_mixed",
    });
  });

  it("Desktop 与已登录 OAuth 同账号时展示合并条目且不重复计为两个账号", async () => {
    renderSection();

    expect(
      await screen.findByText(
        /Matches the signed-in account managed@example.com and was merged/,
      ),
    ).toBeVisible();
    expect(
      screen.getAllByRole("spinbutton", {
        name: /managed@example.com.*reserve threshold/,
      }),
    ).toHaveLength(1);
  });

  it("Desktop 条目禁用时保留同名托管账号而不是静默删掉", async () => {
    mocks.getPolicy.mockResolvedValue({
      enabled: true,
      desktopAccountId: "managed",
      entries: [
        {
          accountId: "native_codex_auth",
          enabled: false,
          reservePercent: 5,
        },
        { accountId: "managed", enabled: true, reservePercent: 5 },
      ],
    });

    renderSection();

    expect(await screen.findAllByText("managed@example.com")).not.toHaveLength(
      0,
    );
    expect(screen.queryByText(/and was merged/)).not.toBeInTheDocument();
  });

  it("点击移除账号时先确认，确认后才调用删除", async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findAllByText("managed@example.com");
    const removeButtons = screen.getAllByTitle("Remove account");
    await user.click(removeButtons[0]);

    expect(mocks.removeAccount).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "移除这个账号？" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "移除账号" }));
    expect(mocks.removeAccount).toHaveBeenCalledTimes(1);
  });

  it("点击注销所有账号时先确认，取消不会注销", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(
      await screen.findByRole("button", { name: "Sign out all accounts" }),
    );
    expect(mocks.logout).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});
