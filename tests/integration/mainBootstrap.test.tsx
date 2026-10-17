import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  app: vi.fn(),
  initializeWindowActivity: vi.fn(),
  syncModelsDevPricingOnStartup: vi.fn(),
  reportFrontendError: vi.fn(),
  roots: [] as Root[],
}));

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  const createRoot: typeof actual.createRoot = (...args) => {
    const root = actual.createRoot(...args);
    mocks.roots.push(root);
    return root;
  };
  return { ...actual, default: { ...actual, createRoot }, createRoot };
});

vi.mock("@/App", () => ({
  default: () => {
    mocks.app();
    return <div data-testid="app">App</div>;
  },
}));

vi.mock("@/components/DatabaseUpgrade", () => ({
  DatabaseUpgrade: ({ payload }: { payload: { kind?: string } }) => (
    <div data-testid="database-upgrade">{payload.kind}</div>
  ),
}));

vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/contexts/UpdateContext", () => ({
  UpdateProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/lib/query", () => ({
  queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

vi.mock("@/i18n", () => {
  const messages: Record<string, string> = {
    "common.loading": "Loading...",
    "errors.startupTimeoutTitle": "Application startup timed out",
    "errors.startupTimeoutMessage": "The initialization check did not reply.",
    "errors.reloadInterface": "Reload interface",
  };
  return { default: { t: (key: string) => messages[key] ?? key } };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  exit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/frontendLogger", () => ({
  installGlobalErrorHandlers: vi.fn(),
  reportFrontendError: mocks.reportFrontendError,
}));

vi.mock("@/lib/modelsDevAutoSync", () => ({
  MODELS_DEV_SYNC_CONFIG_QUERY_KEY: ["models-dev-sync"],
  syncModelsDevPricingOnStartup: mocks.syncModelsDevPricingOnStartup,
}));

vi.mock("@/lib/windowActivity", () => ({
  initializeWindowActivity: mocks.initializeWindowActivity,
}));

async function bootstrap() {
  await act(async () => {
    await import("@/main");
  });
}

describe("application initialization bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.invoke.mockReset().mockResolvedValue(null);
    mocks.syncModelsDevPricingOnStartup
      .mockReset()
      .mockResolvedValue({ skipped: true });
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of mocks.roots.splice(0)) root.unmount();
    });
    document.getElementById("root")?.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows loading while initialization hangs and keeps App blocked after timeout and a late reply", async () => {
    let resolveInitialization!: (value: null) => void;
    mocks.invoke.mockReturnValue(
      new Promise<null>((resolve) => {
        resolveInitialization = resolve;
      }),
    );

    await bootstrap();

    expect(mocks.invoke).toHaveBeenCalledWith("get_init_error");
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(screen.queryByTestId("app")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Application startup timed out",
    );
    expect(
      screen.getByRole("button", { name: "Reload interface" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mocks.app).not.toHaveBeenCalled();
    expect(mocks.initializeWindowActivity).not.toHaveBeenCalled();
    expect(mocks.syncModelsDevPricingOnStartup).not.toHaveBeenCalled();

    await act(async () => {
      resolveInitialization(null);
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(mocks.app).not.toHaveBeenCalled();
    expect(mocks.syncModelsDevPricingOnStartup).not.toHaveBeenCalled();
  });

  it("mounts App after a clean initialization result", async () => {
    await bootstrap();

    expect(screen.getByTestId("app")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.initializeWindowActivity).toHaveBeenCalledOnce();
    expect(mocks.syncModelsDevPricingOnStartup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByTestId("app")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders database upgrade recovery without mounting App", async () => {
    mocks.invoke.mockResolvedValue({ kind: "db_version_too_new" });

    await bootstrap();

    expect(screen.getByTestId("database-upgrade")).toHaveTextContent(
      "db_version_too_new",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mocks.app).not.toHaveBeenCalled();
    expect(mocks.initializeWindowActivity).not.toHaveBeenCalled();
    expect(mocks.syncModelsDevPricingOnStartup).not.toHaveBeenCalled();
  });
});
