import { readFileSync } from "node:fs";
import path from "node:path";
import { createInstance } from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const directory = path.resolve(
  process.cwd(),
  "src-tauri/src/resources/owner_remote",
);
const source = readFileSync(path.join(directory, "console.js"), "utf8");
const html = readFileSync(path.join(directory, "index.html"), "utf8");
const localeResources = Object.fromEntries(
  ["en", "zh", "zh-TW", "ja"].map((language) => [
    language,
    {
      translation: {
        ownerRemoteConsole: JSON.parse(
          readFileSync(
            path.resolve(process.cwd(), `src/i18n/locales/${language}.json`),
            "utf8",
          ),
        ).ownerRemoteConsole,
      },
    },
  ]),
);
type Controller = {
  start(): Promise<void>;
  destroy(): void;
  refresh(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
};
type Payload = Record<string, unknown>;
type Reply = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};
type Handler = (
  route: string,
  method: string,
  body: Payload | undefined,
  init: RequestInit,
) => Reply | Promise<Reply> | undefined;
const response = (body: unknown, status = 200): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});
const session = () => ({
  authenticated: true,
  hostId: "host-one",
  deviceId: "device-one",
  sessionId: "session-one",
  csrfToken: "csrf-one",
});
const snapshot = (overrides: Payload = {}) => ({
  viewId: "view-one",
  canContinue: true,
  expiresInSeconds: 30,
  content: {
    kind: "snapshot",
    threadId: "thread-one",
    latestTurnId: "base-one",
    status: "idle",
    model: "model-one",
    currentDisplay: "unavailable",
    continueBlocker: null,
    turns: [
      {
        id: "base-one",
        status: "completed",
        items: [
          { type: "user", text: "hello" },
          { type: "assistant", text: "Current content" },
        ],
      },
    ],
    ...overrides,
  },
});
const terminalErrorSnapshot = (
  turnStatus = "failed",
  contentOverrides: Payload = {},
  envelopeOverrides: Payload = {},
) => ({
  ...snapshot({
    status: "error",
    turns: [{ id: "base-one", status: turnStatus, items: [] }],
    ...contentOverrides,
  }),
  ...envelopeOverrides,
});
const abortableReply = (
  init: RequestInit,
  delay: number,
  reply: Reply,
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => resolve(reply), delay);
    init.signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
const assertion = () => ({
  id: "credential-one",
  rawId: new Uint8Array([1, 2]).buffer,
  type: "public-key",
  response: {
    clientDataJSON: new Uint8Array([3]).buffer,
    authenticatorData: new Uint8Array([4]).buffer,
    signature: new Uint8Array([5]).buffer,
    userHandle: null,
  },
  getClientExtensionResults: () => ({}),
});
const registration = () => ({
  ...assertion(),
  response: {
    clientDataJSON: new Uint8Array([3]).buffer,
    attestationObject: new Uint8Array([6]).buffer,
    getTransports: () => ["internal"],
  },
});
const flush = async () => {
  for (let index = 0; index < 40; index++) await Promise.resolve();
};
const controllers: Controller[] = [];
const setup = (
  handler?: Handler,
  mountOptions: Record<string, unknown> = {},
) => {
  document.body.innerHTML =
    html
      .match(/<body>([\s\S]*)<\/body>/)?.[1]
      .replace("data-owner-remote-auto", "") || "";
  const root = document.getElementById("owner-remote-console")!;
  let clock = 0,
    active = true;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const route = url.replace("/remote/api/v1", "");
    const method = init.method || "GET";
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Payload)
        : undefined;
    const custom = await handler?.(route, method, body, init);
    if (custom) return custom;
    if (route === "/remote/locales") return response(localeResources);
    if (route === "/session") return response(session());
    if (route === "/conversations")
      return response({
        conversations: [{ threadId: "thread-one", title: "Recent chat" }],
        currentDisplay: "unavailable",
      });
    if (route === "/devices")
      return response({
        devices: [{ deviceId: "device-one", label: "My tablet" }],
      });
    if (route.startsWith("/view?")) return response(snapshot());
    if (route.startsWith("/operations/"))
      return response({
        operationId: route.split("/").at(-1),
        status: "uncertain",
        submitted: false,
        mutationAttempted: true,
      });
    if (route === "/session/auth/options")
      return response({
        ceremonyId: "ceremony-one",
        publicKey: {
          challenge: "AQI",
          allowCredentials: [{ type: "public-key", id: "AQI" }],
        },
        expiresInSeconds: 60,
      });
    if (route === "/session/enroll/options")
      return response({
        ceremonyId: "ceremony-one",
        publicKey: {
          challenge: "AQI",
          user: { id: "AQI", name: "Owner", displayName: "Owner" },
          excludeCredentials: [],
        },
        expiresInSeconds: 60,
      });
    if (route === "/session/auth/finish" || route === "/session/enroll/finish")
      return response(session());
    if (route === "/session/logout") return response({ signedOut: true });
    if (route === "/continue")
      return response({
        operationId: body?.operationId,
        status: "submitted",
        submitted: true,
        mutationAttempted: true,
        acknowledgedTurnId: "accepted-one",
      });
    throw new Error("unexpected_test_route");
  });
  const credentials = {
    get: vi.fn(async (_options: unknown) => assertion()),
    create: vi.fn(async (_options: unknown) => registration()),
  };
  const crypto = {
    getRandomValues: vi.fn((bytes: Uint8Array) => {
      bytes.fill(11);
      return bytes;
    }),
  };
  const exports = new Function(
    `${source.replace(/^export /gm, "")};return { mountOwnerRemoteConsole, decodeOwnerRemoteBase64Url, encodeOwnerRemoteBase64Url };`,
  )() as {
    mountOwnerRemoteConsole(root: HTMLElement, options: object): Controller;
    decodeOwnerRemoteBase64Url(value: string): Uint8Array;
    encodeOwnerRemoteBase64Url(value: ArrayBuffer | Uint8Array): string;
  };
  const controller = exports.mountOwnerRemoteConsole(root, {
    fetch,
    credentials,
    crypto,
    now: () => clock,
    isActive: () => active,
    i18n: createInstance(),
    language: "en",
    ...mountOptions,
  });
  controllers.push(controller);
  const node = <T extends HTMLElement = HTMLElement>(name: string) =>
    root.querySelector<T>(`#${name}`)!;
  const calls = (route: string) =>
    fetch.mock.calls.filter(([url]) => url === `/remote/api/v1${route}`);
  return {
    controller,
    root,
    fetch,
    credentials,
    crypto,
    node,
    calls,
    exports,
    setClock: (value: number) => {
      clock = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/remote/");
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("owner remote browser console", () => {
  it("renders only a selected bounded conversation as text, never Markdown or HTML", async () => {
    const unsafe = '<img src=x onerror="bad()"><script>bad()</script>';
    const harness = setup((route) =>
      route.startsWith("/view?")
        ? response(
            snapshot({
              turns: [
                {
                  status: "completed",
                  items: [
                    { type: "assistant", text: unsafe },
                    { type: "unsupported", text: "hidden raw data" },
                    {
                      type: "reasoning_summary",
                      text: "Public summary",
                      hiddenReasoning: "private reasoning",
                    },
                  ],
                },
              ],
            }),
          )
        : undefined,
    );
    await harness.controller.start();
    expect(
      harness.fetch.mock.calls.some(([url]) => url.includes("/view?")),
    ).toBe(false);
    await harness.controller.selectThread("thread-one");
    expect(harness.node("transcript").textContent).toContain(unsafe);
    expect(harness.node("transcript").querySelector("img, script")).toBeNull();
    expect(harness.node("transcript").textContent).not.toContain(
      "hidden raw data",
    );
    expect(harness.node("transcript").textContent).not.toContain(
      "private reasoning",
    );
    expect(harness.node("view-note").textContent).toContain(
      "not screen sharing",
    );
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("makes no transcript or device request before authentication", async () => {
    const harness = setup((route) =>
      route === "/session"
        ? response({ error: "authentication_required" }, 401)
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.node("workspace").hidden).toBe(true);
    expect(harness.node("transcript").textContent).not.toContain(
      "Current content",
    );
  });

  it("removes invitation fragments before the first request and sends the secret only in POST data", async () => {
    const secret = "one-use-invitation-secret-123456789";
    window.history.replaceState(null, "", `/remote/#invite=${secret}`);
    let unauthenticated = true;
    const harness = setup((route, _method, body) => {
      expect(window.location.hash).toBe("");
      if (route === "/session" && unauthenticated) return response({}, 401);
      if (route === "/session/enroll/options")
        expect(body?.invitationSecret).toBe(secret);
      if (route === "/session/enroll/finish") {
        unauthenticated = false;
        expect(body?.credential).toMatchObject({
          type: "public-key",
          response: { attestationObject: "Bg" },
        });
      }
      return undefined;
    });
    await harness.controller.start();
    expect(harness.node("enroll-form").hidden).toBe(false);
    harness.node<HTMLInputElement>("device-label").value = "My tablet";
    harness
      .node("enroll-form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(harness.credentials.create).toHaveBeenCalledTimes(1);
    expect(harness.node("workspace").hidden).toBe(false);
    expect(harness.root.textContent).not.toContain(secret);
    expect(
      harness.fetch.mock.calls.every(([url]) => !url.includes(secret)),
    ).toBe(true);
  });

  it("uses a remote passkey for re-login but never prompts for passkey on Continue", async () => {
    const harness = setup((route) =>
      route === "/session" ? response({}, 401) : undefined,
    );
    await harness.controller.start();
    harness.node("sign-in").click();
    await flush();
    expect(harness.credentials.get).toHaveBeenCalledTimes(1);
    expect(harness.credentials.get.mock.calls[0][0]).toMatchObject({
      publicKey: { challenge: new Uint8Array([1, 2]) },
    });
    const login = harness.calls("/session/auth/finish")[0][1];
    expect(JSON.parse(String(login.body))).toMatchObject({
      purpose: "login",
      credential: { response: { signature: "BQ", userHandle: null } },
    });
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    expect(harness.calls("/continue")).toHaveLength(1);
    expect(harness.credentials.get).toHaveBeenCalledTimes(1);
    expect(harness.node("action-message").textContent).toContain(
      "not necessarily completed",
    );
  });

  it("double taps and a lost acknowledgement never cause a second Continue POST", async () => {
    const harness = setup((route) => {
      if (route === "/continue")
        throw new Error("secret provider transport text");
      return undefined;
    });
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    harness.node("continue").dispatchEvent(new Event("click"));
    await flush();
    expect(harness.calls("/continue")).toHaveLength(1);
    expect(harness.node("action-message").textContent).toContain("uncertain");
    expect(harness.root.textContent).not.toContain("secret provider");
    await harness.controller.refresh();
    await harness.controller.refresh();
    expect(harness.calls("/continue")).toHaveLength(1);
    expect(
      harness.fetch.mock.calls.some(([url]) =>
        url.includes("/operations/owner-"),
      ),
    ).toBe(true);
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
  });

  it.each([
    { status: "active" },
    { status: "waiting" },
    { status: "unknown" },
    { continueBlocker: "user_action_unavailable" },
  ])(
    "never authorizes a non-idle or unbound snapshot: %o",
    async (override) => {
      const harness = setup((route) =>
        route.startsWith("/view?") ? response(snapshot(override)) : undefined,
      );
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      harness.node("continue").dispatchEvent(new Event("click"));
      await flush();
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
      expect(harness.calls("/continue")).toHaveLength(0);
    },
  );

  it("expires a binding using monotonic time instead of trusting the wall clock", async () => {
    const harness = setup();
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.setClock(30_001);
    harness.node("continue").dispatchEvent(new Event("click"));
    await flush();
    expect(harness.calls("/continue")).toHaveLength(0);
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
  });

  it("pauses polling and invalidates Continue while the page is hidden or unfocused", async () => {
    const harness = setup();
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    const count = harness.fetch.mock.calls.length;
    harness.setActive(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.fetch).toHaveBeenCalledTimes(count);
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    harness.setActive(true);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(harness.fetch.mock.calls.length).toBeGreaterThan(count);
  });

  it("does not equate submitted with completed or unlock until canonical accepted turn is idle", async () => {
    let latestTurnId = "base-one";
    const harness = setup((route) =>
      route.startsWith("/view?")
        ? response(snapshot({ latestTurnId }))
        : route.startsWith("/operations/")
          ? response({
              operationId: route.split("/").at(-1),
              status: "submitted",
              submitted: true,
              mutationAttempted: true,
              acknowledgedTurnId: "accepted-one",
            })
          : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    await harness.controller.refresh();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    latestTurnId = "unrelated-turn";
    await harness.controller.refresh();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    latestTurnId = "accepted-one";
    await harness.controller.refresh();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(false);
    expect(harness.calls("/continue")).toHaveLength(1);
  });

  it("clears transcript on auth loss and ignores an older late view response", async () => {
    let resolveFirst!: (value: Reply) => void;
    const first = new Promise<Reply>((resolve) => {
      resolveFirst = resolve;
    });
    const harness = setup((route) =>
      route === "/view?threadId=first"
        ? first
        : route === "/view?threadId=second"
          ? response({}, 401)
          : undefined,
    );
    await harness.controller.start();
    const oldRead = harness.controller.selectThread("first");
    await flush();
    await harness.controller.selectThread("second");
    resolveFirst(
      response(
        snapshot({
          threadId: "first",
          turns: [
            {
              status: "completed",
              items: [{ type: "assistant", text: "late sensitive content" }],
            },
          ],
        }),
      ),
    );
    await oldRead;
    expect(harness.node("workspace").hidden).toBe(true);
    expect(harness.root.textContent).not.toContain("late sensitive content");
    expect(harness.node("feedback").textContent).toContain(
      "expired or was revoked",
    );
  });

  it("requires a passkey step-up only for device management and clears the short-lived invite", async () => {
    const secret = "new-private-invitation-secret-1234";
    const harness = setup((route, _method, body, init) => {
      if (route === "/session/auth/options") {
        expect(body?.managementAction).toEqual({ action: "invite" });
        expect(init.headers).toMatchObject({ "x-ccsm-csrf": "csrf-one" });
      }
      if (route === "/session/auth/finish") {
        expect(body?.purpose).toBe("management");
        return response({
          management: {
            invitation: { invitationSecret: secret, expiresInSeconds: 60 },
            revoked: false,
          },
        });
      }
      return undefined;
    });
    await harness.controller.start();
    harness.node("invite-device").click();
    await flush();
    expect(harness.credentials.get).toHaveBeenCalledTimes(1);
    expect(harness.node<HTMLInputElement>("invitation-link").value).toContain(
      `#invite=${secret}`,
    );
    await vi.advanceTimersByTimeAsync(60_001);
    expect(harness.node("invitation-result").hidden).toBe(true);
    expect(harness.node<HTMLInputElement>("invitation-link").value).toBe("");
  });

  it("fails read-only without secure operation randomness", async () => {
    const harness = setup();
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.crypto.getRandomValues.mockImplementation(() => {
      throw new Error("randomness unavailable");
    });
    // A host browser's crypto failure must not escape a click handler or send.
    harness.node("continue").click();
    await flush();
    expect(harness.calls("/continue")).toHaveLength(0);
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
  });

  it("uses narrow same-origin, no-store requests and sends CSRF on Continue", async () => {
    const harness = setup();
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    const init = harness.calls("/continue")[0][1];
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        "Content-Type": "application/json",
        "x-ccsm-csrf": "csrf-one",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      viewId: "view-one",
      operationId: expect.stringMatching(/^owner-[a-f0-9]{32}$/),
    });
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("innerHTML");
  });

  it("rejects a malformed idle view without a bound latest turn", async () => {
    const harness = setup((route) =>
      route.startsWith("/view?")
        ? response(snapshot({ latestTurnId: null }))
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").dispatchEvent(new Event("click"));
    await flush();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(harness.calls("/continue")).toHaveLength(0);
  });

  it("auth expiry during submission clears content without a retry or reflected error", async () => {
    const harness = setup((route) =>
      route === "/continue"
        ? response({ error: "secret raw failure" }, 401)
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    expect(harness.calls("/continue")).toHaveLength(1);
    expect(harness.node("workspace").hidden).toBe(true);
    expect(harness.root.textContent).not.toContain("Current content");
    expect(harness.root.textContent).not.toContain("secret raw failure");
    expect(harness.node("feedback").textContent).toContain(
      "expired or was revoked",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.calls("/continue")).toHaveLength(1);
  });

  it("treats unknown or mismatched operation receipts as uncertain, never no-mutation proof", async () => {
    const harness = setup((route) =>
      route === "/continue"
        ? response({
            operationId: "wrong-operation",
            status: "refused",
            detail: "secret provider data",
          })
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    await harness.controller.refresh();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(harness.node("action-message").textContent).toContain("uncertain");
    expect(harness.root.textContent).not.toContain("secret provider data");
    expect(harness.calls("/continue")).toHaveLength(1);
  });

  it("limits downloaded response and rendered item/text sizes", async () => {
    let oversized = false;
    const harness = setup((route) =>
      route.startsWith("/view?")
        ? response(
            snapshot({
              turns: [
                {
                  status: "completed",
                  items: Array.from({ length: 40 }, () => ({
                    type: "assistant",
                    text: "x".repeat(oversized ? 300_000 : 5000),
                  })),
                },
              ],
            }),
          )
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    const bodies = Array.from(
      harness.node("transcript").querySelectorAll(".message-text"),
    );
    expect(
      bodies.every((body) => (body.textContent?.length || 0) <= 4096),
    ).toBe(true);
    expect(
      bodies.reduce((sum, body) => sum + (body.textContent?.length || 0), 0),
    ).toBe(32768);
    oversized = true;
    await harness.controller.refresh();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(harness.node("view-status").textContent).toBe("Stale snapshot");
    expect(harness.node("transcript").textContent?.length).toBeLessThan(34_000);
  });

  it("revoking the current credential requires owner-side step-up and clears the session", async () => {
    const harness = setup((route, _method, body) => {
      if (route === "/session/auth/options")
        expect(body?.managementAction).toEqual({
          action: "revoke_credential",
          deviceId: "device-one",
        });
      if (route === "/session/auth/finish")
        return response({ management: { revoked: true } });
      return undefined;
    });
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness
      .node("devices-list")
      .querySelector<HTMLButtonElement>("button")!
      .click();
    await flush();
    expect(harness.credentials.get).toHaveBeenCalledTimes(1);
    expect(harness.node("workspace").hidden).toBe(true);
    expect(harness.node("transcript").textContent).not.toContain(
      "Current content",
    );
    expect(harness.node("feedback").textContent).toContain("revoked");
  });

  it("clears content but does not claim sign-out succeeded when its acknowledgement is lost", async () => {
    const harness = setup((route) => {
      if (route === "/session/logout")
        throw new Error("private transport detail");
      return undefined;
    });
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("logout").click();
    await flush();
    expect(harness.node("workspace").hidden).toBe(true);
    expect(harness.node("transcript").textContent).not.toContain(
      "Current content",
    );
    expect(harness.node("feedback").textContent).toContain("not confirmed");
    expect(harness.root.textContent).not.toContain("private transport detail");
    expect(harness.calls("/session/logout")).toHaveLength(1);
  });

  it("destroying the client invalidates a late view and removes poll listeners", async () => {
    let resolveView!: (value: Reply) => void;
    const view = new Promise<Reply>((resolve) => {
      resolveView = resolve;
    });
    const harness = setup((route) =>
      route.startsWith("/view?") ? view : undefined,
    );
    await harness.controller.start();
    const reading = harness.controller.selectThread("thread-one");
    await flush();
    harness.controller.destroy();
    resolveView(response(snapshot()));
    await reading;
    const calls = harness.fetch.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.fetch).toHaveBeenCalledTimes(calls);
    expect(harness.node("transcript").textContent).not.toContain(
      "Current content",
    );
  });
  it("requires explicit native canContinue proof even for valid idle renderer content", async () => {
    const harness = setup((route) =>
      route.startsWith("/view?")
        ? response({ ...snapshot(), canContinue: false })
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    expect(harness.node("transcript").textContent).toContain("Current content");
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(harness.node("action-message").textContent).toContain("read-only");
    harness.node("continue").dispatchEvent(new Event("click"));
    await flush();
    expect(harness.calls("/continue")).toHaveLength(0);
  });

  it.each(["failed", "interrupted"])(
    "enables a native-bound terminal error without claiming idle: %s",
    async (status) => {
      const harness = setup((route) =>
        route.startsWith("/view?")
          ? response(terminalErrorSnapshot(status))
          : undefined,
      );
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      expect(harness.node("view-status").dataset.status).toBe("error");
      expect(harness.node("view-status").textContent).toBe("Runtime error");
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(false);
      expect(harness.node("action-message").textContent).toContain(
        "ended with an error",
      );
      expect(harness.node("action-message").textContent).not.toContain(
        "is idle",
      );
      harness.node("continue").click();
      await flush();
      expect(harness.calls("/continue")).toHaveLength(1);
    },
  );

  it.each([
    ["completed latest", terminalErrorSnapshot("completed")],
    ["in-progress latest", terminalErrorSnapshot("inProgress")],
    ["unknown latest", terminalErrorSnapshot("unknown")],
    ["missing latest", terminalErrorSnapshot("failed", { turns: [] })],
    [
      "unbound latest",
      terminalErrorSnapshot("failed", { latestTurnId: "other-turn" }),
    ],
    ["active thread", terminalErrorSnapshot("failed", { status: "active" })],
    ["waiting thread", terminalErrorSnapshot("failed", { status: "waiting" })],
    ["unknown thread", terminalErrorSnapshot("failed", { status: "unknown" })],
    [
      "raw unvalidated status",
      terminalErrorSnapshot("failed", { status: "systemError" }),
    ],
    [
      "native refusal",
      terminalErrorSnapshot("failed", {}, { canContinue: false }),
    ],
    [
      "native blocker",
      terminalErrorSnapshot("failed", { continueBlocker: "thread_not_idle" }),
    ],
    ["no capability", terminalErrorSnapshot("failed", {}, { viewId: null })],
  ])(
    "keeps terminal error read-only without canonical proof: %s",
    async (_label, view) => {
      const harness = setup((route) =>
        route.startsWith("/view?") ? response(view) : undefined,
      );
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
      harness.node("continue").dispatchEvent(new Event("click"));
      await flush();
      expect(harness.calls("/continue")).toHaveLength(0);
    },
  );

  it("waits for a 28-second native Continue acknowledgement without abort or resend", async () => {
    let signal: AbortSignal | null | undefined;
    const harness = setup((route, _method, body, init) => {
      if (route !== "/continue") return undefined;
      signal = init.signal;
      return abortableReply(
        init,
        28_500,
        response({
          operationId: body?.operationId,
          status: "submitted",
          submitted: true,
          mutationAttempted: true,
          acknowledgedTurnId: "accepted-one",
        }),
      );
    });
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal?.aborted).toBe(false);
    expect(harness.node("action-message").textContent).toContain("pending");
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(8500);
    expect(signal?.aborted).toBe(false);
    expect(harness.node("action-message").textContent).toContain("submitted");
    expect(harness.calls("/continue")).toHaveLength(1);
  });

  it.each([false, true])(
    "times out Continue at 45 seconds and only reconciles its exact operation (auth loss: %s)",
    async (authLoss) => {
      let signal: AbortSignal | null | undefined;
      let operationId: unknown;
      const harness = setup((route, _method, body, init) => {
        if (route === "/continue") {
          signal = init.signal;
          operationId = body?.operationId;
          return abortableReply(init, 90_000, response({}));
        }
        if (route.startsWith("/operations/"))
          return authLoss
            ? response({}, 401)
            : response({
                operationId: route.split("/").at(-1),
                status: "pending",
                submitted: false,
                mutationAttempted: false,
              });
        return undefined;
      });
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      harness.node("continue").click();
      await flush();
      await vi.advanceTimersByTimeAsync(44_999);
      expect(signal?.aborted).toBe(false);
      expect(harness.calls("/continue")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(harness.node("action-message").textContent).toContain("uncertain");
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(2500);
      expect(harness.calls(`/operations/${operationId}`)).toHaveLength(1);
      expect(harness.calls("/continue")).toHaveLength(1);
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
      if (authLoss) {
        expect(harness.node("workspace").hidden).toBe(true);
        expect(harness.root.textContent).not.toContain("Current content");
        expect(harness.node("feedback").textContent).toContain(
          "will not be resent",
        );
      }
    },
  );

  it.each([
    ["missing flags", {}],
    ["submitted true", { submitted: true, mutationAttempted: false }],
    ["mutation true", { submitted: false, mutationAttempted: true }],
    ["invalid flag", { submitted: false, mutationAttempted: null }],
    [
      "unexpected ACK",
      {
        submitted: false,
        mutationAttempted: false,
        acknowledgedTurnId: "accepted-one",
      },
    ],
    [
      "null ACK",
      { submitted: false, mutationAttempted: false, acknowledgedTurnId: null },
    ],
    [
      "unexpected field",
      {
        submitted: false,
        mutationAttempted: false,
        private: "private-receipt-marker",
      },
    ],
  ])(
    "never unlocks a same-operation malformed refusal: %s",
    async (_label, fields) => {
      const harness = setup((route, _method, body) =>
        route === "/continue" || route.startsWith("/operations/")
          ? response({
              operationId:
                route === "/continue"
                  ? body?.operationId
                  : route.split("/").at(-1),
              status: "refused",
              ...fields,
            })
          : undefined,
      );
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      harness.node("continue").click();
      await flush();
      await harness.controller.refresh();
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
      expect(harness.node("action-message").textContent).toContain("uncertain");
      expect(harness.root.textContent).not.toContain("private-receipt-marker");
      expect(harness.calls("/continue")).toHaveLength(1);
    },
  );

  it.each([
    [
      "unknown status",
      { status: "unknown", submitted: false, mutationAttempted: false },
    ],
    [
      "noncanonical completed",
      {
        status: "completed",
        submitted: true,
        mutationAttempted: true,
        acknowledgedTurnId: "accepted-one",
      },
    ],
    [
      "submitted without ACK",
      { status: "submitted", submitted: true, mutationAttempted: true },
    ],
    [
      "submitted false",
      {
        status: "submitted",
        submitted: false,
        mutationAttempted: true,
        acknowledgedTurnId: "accepted-one",
      },
    ],
    [
      "submitted without mutation",
      {
        status: "submitted",
        submitted: true,
        mutationAttempted: false,
        acknowledgedTurnId: "accepted-one",
      },
    ],
    [
      "submitted old ACK",
      {
        status: "submitted",
        submitted: true,
        mutationAttempted: true,
        acknowledgedTurnId: "base-one",
      },
    ],
    [
      "submitted unsafe ACK",
      {
        status: "submitted",
        submitted: true,
        mutationAttempted: true,
        acknowledgedTurnId: "../unsafe",
      },
    ],
    [
      "pending with ACK",
      {
        status: "pending",
        submitted: false,
        mutationAttempted: false,
        acknowledgedTurnId: "accepted-one",
      },
    ],
    [
      "uncertain without mutation",
      { status: "uncertain", submitted: false, mutationAttempted: false },
    ],
  ])(
    "keeps malformed canonical receipt blocked through GET reconciliation: %s",
    async (_label, receipt) => {
      const harness = setup((route, _method, body) =>
        route === "/continue" || route.startsWith("/operations/")
          ? response({
              operationId:
                route === "/continue"
                  ? body?.operationId
                  : route.split("/").at(-1),
              ...receipt,
            })
          : undefined,
      );
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      harness.node("continue").click();
      await flush();
      await harness.controller.refresh();
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
      expect(harness.node("action-message").textContent).toContain("uncertain");
      expect(harness.calls("/continue")).toHaveLength(1);
    },
  );

  it("keeps read requests bounded at 20 seconds instead of extending native view authority", async () => {
    let signal: AbortSignal | null | undefined;
    const harness = setup((route, _method, _body, init) => {
      if (!route.startsWith("/view?")) return undefined;
      signal = init.signal;
      return abortableReply(init, 60_000, response(snapshot()));
    });
    await harness.controller.start();
    const selected = harness.controller.selectThread("thread-one");
    await flush();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await selected;
    expect(signal?.aborted).toBe(true);
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(harness.calls("/continue")).toHaveLength(0);
  });

  it("keeps authentication POST requests bounded at 20 seconds", async () => {
    let signal: AbortSignal | null | undefined;
    const harness = setup((route, _method, _body, init) => {
      if (route === "/session") return response({}, 401);
      if (route !== "/session/auth/options") return undefined;
      signal = init.signal;
      return abortableReply(init, 60_000, response({}));
    });
    await harness.controller.start();
    harness.node("sign-in").click();
    await flush();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(harness.node("workspace").hidden).toBe(true);
    expect(harness.calls("/session/auth/options")).toHaveLength(1);
    expect(harness.calls("/continue")).toHaveLength(0);
  });

  it.each(["en", "zh", "zh-TW", "ja"])(
    "keeps terminal error-ready copy distinct from idle in canonical locale: %s",
    async (language) => {
      const harness = setup(
        (route) =>
          route.startsWith("/view?")
            ? response(terminalErrorSnapshot())
            : undefined,
        { language },
      );
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      const messages = localeResources[language].translation.ownerRemoteConsole;
      expect(harness.node("view-status").textContent).toBe(
        messages.status.error,
      );
      expect(harness.node("action-message").textContent).toBe(
        messages.message.errorReady,
      );
      expect(messages.message.errorReady).not.toBe(messages.message.idleReady);
      expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(false);
    },
  );

  it("unlocks only after an explicit canonical no-mutation refusal and a fresh view", async () => {
    const harness = setup((route, _method, body) =>
      route === "/continue"
        ? response({
            operationId: body?.operationId,
            status: "refused",
            submitted: false,
            mutationAttempted: false,
          })
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    await harness.controller.refresh();
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(false);
    expect(harness.calls("/continue")).toHaveLength(1);
  });

  it("renders an explicit null native view binding as read-only content", async () => {
    const harness = setup((route) =>
      route.startsWith("/view?")
        ? response({
            ...snapshot(),
            canContinue: false,
            viewId: null,
            expiresInSeconds: 0,
          })
        : undefined,
    );
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    expect(harness.node("transcript").textContent).toContain("Current content");
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(harness.node("view-status").textContent).toBe("Idle");
  });

  it("labels a lost-auth in-flight mutation honestly and does not clear its uncertainty on re-login", async () => {
    let authenticated = true;
    const harness = setup((route) => {
      if (route === "/session")
        return response(
          authenticated ? session() : {},
          authenticated ? 200 : 401,
        );
      if (route === "/continue") {
        authenticated = false;
        return response({}, 401);
      }
      return undefined;
    });
    await harness.controller.start();
    await harness.controller.selectThread("thread-one");
    harness.node("continue").click();
    await flush();
    expect(harness.node("feedback").textContent).toContain(
      "may already have been submitted",
    );
    expect(harness.node("feedback").textContent).toContain(
      "will not be resent",
    );
    harness.node("sign-in").click();
    await flush();
    await harness.controller.selectThread("thread-one");
    expect(harness.node<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(harness.node("action-message").textContent).toContain("uncertain");
    expect(harness.calls("/continue")).toHaveLength(1);
  });

  it("marks revoked credentials and disables their management action", async () => {
    const harness = setup((route) =>
      route === "/devices"
        ? response({
            devices: [
              { deviceId: "revoked-one", label: "Old browser", revoked: true },
            ],
          })
        : undefined,
    );
    await harness.controller.start();
    expect(harness.node("devices-list").textContent).toContain("revoked");
    expect(
      harness.node("devices-list").querySelector<HTMLButtonElement>("button")!
        .disabled,
    ).toBe(true);
  });

  it.each(["en", "zh", "zh-TW", "ja"])(
    "boots the console through canonical i18next translations: %s",
    async (language) => {
      const harness = setup(undefined, { language });
      await harness.controller.start();
      await harness.controller.selectThread("thread-one");
      const translations =
        localeResources[language].translation.ownerRemoteConsole;
      expect(document.documentElement.lang).toBe(language);
      expect(document.title).toBe(translations.page.title);
      expect(harness.node("continue").textContent).toBe(
        translations.page.sendContinue,
      );
      expect(harness.node("view-status").textContent).toBe(
        translations.status.idle,
      );
      expect(harness.node("action-message").textContent).toBe(
        translations.message.idleReady,
      );
      expect(harness.node("transcript").textContent).not.toContain(
        "ownerRemoteConsole.",
      );
    },
  );

  it("fails closed before authentication when the local i18next asset is unavailable", async () => {
    const harness = setup(undefined, { i18n: null });
    await harness.controller.start();
    harness.node("sign-in").click();
    await flush();
    expect(harness.fetch).toHaveBeenCalledTimes(0);
    expect(harness.node<HTMLButtonElement>("sign-in").disabled).toBe(true);
    expect(harness.node("feedback").textContent).toContain(
      "no action was sent",
    );
    expect(harness.credentials.get).toHaveBeenCalledTimes(0);
  });

  it("keeps the canonical console translation shape and interpolation placeholders aligned", () => {
    const paths = (value: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(value)
        .flatMap(([key, child]) =>
          typeof child === "object" && child !== null
            ? paths(child as Record<string, unknown>, `${prefix}${key}.`)
            : [`${prefix}${key}`],
        )
        .sort();
    const english = localeResources.en.translation.ownerRemoteConsole;
    for (const resource of Object.values(localeResources)) {
      const namespace = resource.translation.ownerRemoteConsole;
      expect(paths(namespace)).toEqual(paths(english));
      for (const section of Object.keys(english))
        for (const key of Object.keys(english[section])) {
          const placeholders = (value: string) =>
            value.match(/\{\{[^}]+\}\}/g)?.sort() || [];
          expect(placeholders(namespace[section][key])).toEqual(
            placeholders(english[section][key]),
          );
        }
    }
  });
  it("roundtrips only bounded base64url passkey data", () => {
    const harness = setup();
    expect(
      harness.exports.encodeOwnerRemoteBase64Url(new Uint8Array([251, 255, 0])),
    ).toBe("-_8A");
    expect(harness.exports.decodeOwnerRemoteBase64Url("-_8A")).toEqual(
      new Uint8Array([251, 255, 0]),
    );
    expect(() =>
      harness.exports.decodeOwnerRemoteBase64Url("not base64!"),
    ).toThrow("invalid_passkey_data");
    expect(() => harness.exports.decodeOwnerRemoteBase64Url("a")).toThrow(
      "invalid_passkey_data",
    );
  });
});
