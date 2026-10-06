import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useStreamRetryActivity,
  useStreamRetryActivityBridge,
} from "./useStreamRetryActivity";

type EventHandler = (event: { payload: unknown }) => void;

const listeners = vi.hoisted(() => new Map<string, EventHandler>());
const unlisten = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() =>
  vi.fn(async (event: string, handler: EventHandler) => {
    listeners.set(event, handler);
    return unlisten;
  }),
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

function Bridge() {
  useStreamRetryActivityBridge();
  return null;
}

function ActivityCount() {
  const activities = useStreamRetryActivity();
  return <output data-testid="activity-count">{activities.length}</output>;
}

describe("useStreamRetryActivity", () => {
  it("retains an activity received before the panel mounts", async () => {
    const bridge = render(<Bridge />);

    await waitFor(() =>
      expect(listeners.get("stream-retry-activity")).toBeTypeOf("function"),
    );
    act(() => {
      listeners.get("stream-retry-activity")?.({
        payload: {
          timestamp: "2026-10-06T10:00:00Z",
          stage: "chat_completions",
          event: "retry_scheduled",
          attempt: 1,
          maxAttempts: 5,
          sessionId: "session",
          model: "model",
          providerId: "provider",
          reasonClass: "premature_eof",
        },
      });
    });

    bridge.unmount();
    render(<ActivityCount />);
    await waitFor(() =>
      expect(screen.getByTestId("activity-count")).toHaveTextContent("1"),
    );
  });
});
