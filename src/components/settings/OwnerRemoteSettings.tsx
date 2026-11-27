import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ownerRemoteApi, type OwnerRemoteStatus } from "@/lib/api/ownerRemote";
import { OwnerRemoteTransportGuide } from "./OwnerRemoteTransportGuide";
import {
  tailscaleApi,
  type TailscaleState,
  type TailscaleStatus,
} from "@/lib/api/tailscale";

function normalizeHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

type PendingAction =
  | "status"
  | "start"
  | "stop"
  | "invite"
  | "tailscaleConnect"
  | "tailscaleVerify";

const tailscaleStateKeys: Record<TailscaleState, string> = {
  missing: "settings.ownerRemote.tailscaleMissing",
  needsLogin: "settings.ownerRemote.tailscaleNeedsLogin",
  needsApproval: "settings.ownerRemote.tailscaleNeedsApproval",
  serveMissing: "settings.ownerRemote.tailscaleServeMissing",
  targetMismatch: "settings.ownerRemote.tailscaleTargetMismatch",
  originMismatch: "settings.ownerRemote.tailscaleOriginMismatch",
  ready: "settings.ownerRemote.tailscaleReady",
  reachable: "settings.ownerRemote.tailscaleReachable",
  unreachable: "settings.ownerRemote.tailscaleUnreachable",
  error: "settings.ownerRemote.tailscaleError",
};

const tailscaleErrors: Record<string, string> = {
  tailscale_install_failed: "tailscaleInstallFailed",
  tailscale_install_unsupported: "tailscaleInstallUnsupported",
  tailscale_winget_unavailable: "tailscaleWingetUnavailable",
  tailscale_login_failed: "tailscaleLoginFailed",
  tailscale_login_timeout: "tailscaleLoginTimeout",
  tailscale_serve_failed: "tailscaleServeFailed",
  tailscale_serve_conflict: "tailscaleTargetMismatch",
  tailscale_funnel_enabled: "tailscaleFunnelEnabled",
  tailscale_owner_remote_start_failed: "tailscaleListenerFailed",
  tailscale_probe_failed: "tailscaleProbeFailed",
  tailscale_command_failed: "tailscaleCommandFailed",
  tailscale_setup_in_progress: "tailscaleSetupInProgress",
};

function tailscaleErrorKey(error: unknown): string {
  return typeof error === "string" &&
    Object.prototype.hasOwnProperty.call(tailscaleErrors, error)
    ? tailscaleErrors[error]
    : "tailscaleActionError";
}

/** Own native status and operations above the tab-mounted view. */
export function useOwnerRemoteController(active: boolean) {
  const [status, setStatus] = useState<OwnerRemoteStatus | null>(null);
  const [origin, setOrigin] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    "status",
  );
  const [statusFailed, setStatusFailed] = useState(false);
  const [error, setError] = useState(false);
  const [invite, setInvite] = useState<{
    url: string;
    expiresAt: number;
  } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const mounted = useRef(false);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const statusInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const refreshStatusRef = useRef<(() => Promise<void>) | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const inviteViewVersion = useRef(0);
  const [tailscaleStatus, setTailscaleStatus] =
    useState<TailscaleStatus | null>(null);
  const [tailscaleChecking, setTailscaleChecking] = useState(false);
  const [tailscaleError, setTailscaleError] = useState<string | null>(null);
  const tailscaleReadRevision = useRef(0);
  const tailscaleReadInFlight = useRef(false);

  const clearTailscaleVerification = useCallback(() => {
    setTailscaleStatus((previous) =>
      previous?.state === "reachable" || previous?.state === "unreachable"
        ? { ...previous, state: "ready", reachable: false, error: null }
        : previous,
    );
  }, []);

  const invalidateTailscaleProof = useCallback(() => {
    tailscaleReadRevision.current += 1;
    tailscaleReadInFlight.current = false;
    setTailscaleChecking(false);
    setTailscaleError(null);
    clearTailscaleVerification();
  }, [clearTailscaleVerification]);

  const run = useCallback(
    async <T,>(
      actionName: PendingAction,
      action: () => Promise<T>,
      onSuccess: (result: T) => void,
      onFailure?: (error: unknown) => void,
    ) => {
      // Lock synchronously: two clicks in the same render must not start two
      // listeners or overlap a status read with a configuration mutation.
      if (!mounted.current || inFlight.current) return;
      inFlight.current = true;
      statusInFlight.current = actionName === "status";
      if (statusInFlight.current) refreshQueued.current = false;
      const version = ++requestVersion.current;
      const isCurrent = () =>
        mounted.current && version === requestVersion.current;
      setPendingAction(actionName);
      setError(false);
      setInvite(null);
      const tailscaleAction =
        actionName === "tailscaleConnect" || actionName === "tailscaleVerify";
      if (tailscaleAction || actionName === "start" || actionName === "stop") {
        invalidateTailscaleProof();
      }
      try {
        const result = await action();
        if (isCurrent()) onSuccess(result);
      } catch (failure) {
        // Never log or reflect native exceptions: enrollment can carry secrets.
        if (isCurrent()) {
          if (!tailscaleAction) setError(true);
          onFailure?.(failure);
          if (
            actionName === "start" ||
            actionName === "stop" ||
            actionName === "tailscaleConnect"
          ) {
            // A rejected mutation is not a rollback: stop closes the listener
            // even when persisting opt-out fails. Keep the action lock until
            // native status has reconciled both intent and runtime readiness.
            setStatusFailed(true);
            // Activation already refreshes status. Do not issue inactive-tab
            // reconciliation IPC after a rejected mutation; keep the status
            // unavailable until the next active read succeeds.
            if (activeRef.current) {
              try {
                const next = await ownerRemoteApi.getStatus();
                if (isCurrent()) {
                  setStatus(next);
                  setStatusFailed(false);
                  if (next.httpsOrigin) setOrigin(next.httpsOrigin);
                }
              } catch {
                if (isCurrent()) setStatusFailed(true);
              }
            }
          }
        }
      } finally {
        if (isCurrent()) {
          inFlight.current = false;
          statusInFlight.current = false;
          setPendingAction(null);
          if (refreshQueued.current && activeRef.current) {
            refreshQueued.current = false;
            void refreshStatusRef.current?.();
          }
        }
      }
    },
    [invalidateTailscaleProof],
  );

  const refreshStatus = useCallback(() => {
    // A read dispatched before leaving Connections may complete after a return.
    // Coalesce that reactivation into one fresh read, never overlap native IPC.
    if (inFlight.current && statusInFlight.current)
      refreshQueued.current = true;
    return run(
      "status",
      () => ownerRemoteApi.getStatus(),
      (next) => {
        setStatus(next);
        setOrigin(next.httpsOrigin ?? "");
        setStatusFailed(false);
        setError(Boolean(next.error));
        if (!next.running) clearTailscaleVerification();
      },
      () => {
        setStatusFailed(true);
        clearTailscaleVerification();
      },
    );
  }, [clearTailscaleVerification, run]);
  refreshStatusRef.current = refreshStatus;

  const refreshTailscale = useCallback(async () => {
    if (
      !mounted.current ||
      tailscaleReadInFlight.current ||
      (inFlight.current && !statusInFlight.current)
    )
      return;
    tailscaleReadInFlight.current = true;
    const revision = ++tailscaleReadRevision.current;
    const isCurrent = () =>
      mounted.current && revision === tailscaleReadRevision.current;
    setTailscaleChecking(true);
    setTailscaleError(null);
    try {
      const next = await tailscaleApi.getStatus();
      if (isCurrent()) setTailscaleStatus(next);
    } catch (failure) {
      if (isCurrent()) {
        setTailscaleStatus(null);
        setTailscaleError(tailscaleErrorKey(failure));
      }
    } finally {
      if (isCurrent()) {
        tailscaleReadInFlight.current = false;
        setTailscaleChecking(false);
      }
    }
  }, []);

  // Only actual owner teardown invalidates mutations; hiding a tab does not.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
      inFlight.current = false;
      statusInFlight.current = false;
      refreshQueued.current = false;
      tailscaleReadRevision.current += 1;
      tailscaleReadInFlight.current = false;
    };
  }, []);

  useEffect(() => {
    if (active) {
      // run() retains a pending mutation's lock instead of racing its IPC.
      void refreshStatus();
      void refreshTailscale();
    } else {
      // Enrollment material is view-scoped, unlike status and mutations.
      inviteViewVersion.current += 1;
      setInvite(null);
    }
  }, [active, refreshStatus, refreshTailscale]);

  useEffect(() => {
    if (!invite) return;
    const update = () => {
      const seconds = Math.max(
        0,
        Math.ceil((invite.expiresAt - Date.now()) / 1000),
      );
      setSecondsLeft(seconds);
      if (!seconds) setInvite(null);
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [invite]);

  const busy = pendingAction !== null;
  const originPinned = Boolean(status?.httpsOrigin);
  const normalizedOrigin = normalizeHttpsOrigin(status?.httpsOrigin ?? origin);
  const enabled = status?.enabled === true;
  const running = status?.running === true && !statusFailed;
  const needsStatusRetry = statusFailed || (!enabled && Boolean(status?.error));
  const statusUnavailable = !status || needsStatusRetry;
  const applyStatus = (next: OwnerRemoteStatus) => {
    setStatus(next);
    setStatusFailed(false);
    setError(Boolean(next.error));
  };
  const start = () => {
    if (!normalizedOrigin) return;
    void run(
      "start",
      () => ownerRemoteApi.start(normalizedOrigin),
      (next) => {
        applyStatus(next);
        setOrigin(next.httpsOrigin ?? normalizedOrigin);
      },
    );
  };

  const stop = () => void run("stop", () => ownerRemoteApi.stop(), applyStatus);
  const changeOrigin = (value: string) => {
    if (originPinned) return;
    setOrigin(value);
    setInvite(null);
  };
  const createInvite = () => {
    const viewVersion = inviteViewVersion.current;
    void run(
      "invite",
      () => ownerRemoteApi.createInvite(),
      (invitation) => {
        if (
          !activeRef.current ||
          viewVersion !== inviteViewVersion.current ||
          !status?.httpsOrigin
        )
          return;
        if (
          !/^[A-Za-z0-9_-]{22,256}$/.test(invitation.invitationSecret) ||
          !Number.isFinite(invitation.expiresInSeconds) ||
          invitation.expiresInSeconds <= 0 ||
          invitation.expiresInSeconds > 60
        ) {
          throw new Error("invalid_invitation");
        }
        setInvite({
          url: `${status.httpsOrigin}/remote/#invite=${invitation.invitationSecret}`,
          expiresAt: Date.now() + invitation.expiresInSeconds * 1000,
        });
      },
    );
  };

  const applyTailscaleStatus = (next: TailscaleStatus) => {
    setTailscaleStatus(next);
    if (next.error) setTailscaleError(tailscaleErrorKey(next.error));
  };
  const connectTailscale = () =>
    void run(
      "tailscaleConnect",
      async () => {
        const tailscale = await tailscaleApi.connect();
        const owner = await ownerRemoteApi.getStatus().catch(() => null);
        return { tailscale, owner };
      },
      ({ tailscale, owner }) => {
        if (owner) {
          applyStatus(owner);
          if (owner.httpsOrigin) setOrigin(owner.httpsOrigin);
        } else {
          setStatusFailed(true);
        }
        applyTailscaleStatus(tailscale);
      },
      (failure) => setTailscaleError(tailscaleErrorKey(failure)),
    );
  const verifyTailscale = () =>
    void run(
      "tailscaleVerify",
      () => tailscaleApi.verifyOwnerRemote(),
      applyTailscaleStatus,
      (failure) => setTailscaleError(tailscaleErrorKey(failure)),
    );

  return {
    status,
    origin,
    pendingAction,
    error,
    invite,
    secondsLeft,
    busy,
    originPinned,
    normalizedOrigin,
    enabled,
    running,
    needsStatusRetry,
    statusUnavailable,
    refreshStatus,
    start,
    stop,
    changeOrigin,
    createInvite,
    tailscaleStatus,
    tailscaleChecking,
    tailscaleError,
    refreshTailscale,
    connectTailscale,
    verifyTailscale,
  };
}

interface OwnerRemoteSettingsProps {
  controller: ReturnType<typeof useOwnerRemoteController>;
}

/** Local enrollment/setup only; deliberately no per-action approval controls. */
export function OwnerRemoteSettings({ controller }: OwnerRemoteSettingsProps) {
  const { t } = useTranslation();
  const {
    status,
    origin,
    pendingAction,
    error,
    invite,
    secondsLeft,
    busy,
    originPinned,
    normalizedOrigin,
    enabled,
    running,
    needsStatusRetry,
    statusUnavailable,
    refreshStatus,
    start,
    stop,
    changeOrigin,
    createInvite,
    tailscaleStatus,
    tailscaleChecking,
    tailscaleError,
    refreshTailscale,
    connectTailscale,
    verifyTailscale,
  } = controller;

  const tailscaleState = tailscaleStatus?.state;
  const verified =
    running &&
    pendingAction !== "status" &&
    !tailscaleChecking &&
    tailscaleState === "reachable" &&
    tailscaleStatus?.reachable;
  const canVerify =
    running &&
    (tailscaleState === "ready" ||
      tailscaleState === "reachable" ||
      tailscaleState === "unreachable");
  const tailscaleStateLabel = !tailscaleState
    ? t("settings.ownerRemote.tailscaleNotChecked")
    : tailscaleState === "reachable" && !verified
      ? t("settings.ownerRemote.tailscaleReady")
      : t(tailscaleStateKeys[tailscaleState]);
  const tailscaleActionLabel =
    pendingAction === "tailscaleConnect"
      ? t("settings.ownerRemote.tailscaleActionConnect")
      : pendingAction === "tailscaleVerify"
        ? t("settings.ownerRemote.tailscaleActionVerify")
        : tailscaleChecking
          ? t("settings.ownerRemote.tailscaleActionStatus")
          : null;
  const tailscaleStatusError =
    tailscaleError ??
    (tailscaleStatus?.error ? tailscaleErrorKey(tailscaleStatus.error) : null);

  return (
    <section
      className="rounded-lg border border-border p-4 space-y-3"
      aria-busy={busy}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id="owner-remote-title" className="text-sm font-medium">
            {t("settings.ownerRemote.title")}
          </h3>
          <p
            id="owner-remote-description"
            className="text-xs text-muted-foreground"
          >
            {t("settings.ownerRemote.description")}
          </p>
        </div>
        <Switch
          id="owner-remote-enabled"
          aria-labelledby="owner-remote-title"
          aria-describedby="owner-remote-description owner-remote-state"
          checked={enabled}
          disabled={
            busy || (!enabled && (statusUnavailable || !normalizedOrigin))
          }
          onCheckedChange={(checked) => {
            if (checked) {
              start();
            } else {
              stop();
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id="owner-remote-state" className="text-xs" role="status">
          {pendingAction === "status"
            ? t("settings.ownerRemote.loading", {
                defaultValue: "Checking remote access…",
              })
            : statusUnavailable
              ? t("settings.ownerRemote.statusUnavailable", {
                  defaultValue: "Status unavailable",
                })
              : t(
                  running
                    ? "settings.ownerRemote.running"
                    : enabled
                      ? "settings.ownerRemote.unavailable"
                      : "settings.ownerRemote.off",
                )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void refreshStatus()}
        >
          {needsStatusRetry
            ? t("settings.ownerRemote.retryStatus", {
                defaultValue: "Retry status",
              })
            : t("settings.ownerRemote.refreshStatus", {
                defaultValue: "Refresh status",
              })}
        </Button>
      </div>
      <section
        className="space-y-2 border-t border-border/70 pt-3"
        aria-labelledby="owner-remote-tailscale-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h4
              id="owner-remote-tailscale-title"
              className="text-sm font-medium"
            >
              {t("settings.ownerRemote.tailscaleTitle", {
                defaultValue: "Tailscale connection",
              })}
            </h4>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {tailscaleActionLabel ?? tailscaleStateLabel}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || tailscaleChecking}
            onClick={() => void refreshTailscale()}
          >
            {t("settings.ownerRemote.tailscaleRefresh", {
              defaultValue: "Check Tailscale",
            })}
          </Button>
        </div>
        {tailscaleStatusError ? (
          <p className="text-xs text-destructive" role="alert">
            {t(`settings.ownerRemote.${tailscaleStatusError}`)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {!verified ? (
            <Button
              size="sm"
              disabled={busy || tailscaleChecking}
              onClick={connectTailscale}
            >
              {t("settings.ownerRemote.tailscaleConnect")}
            </Button>
          ) : null}
          {canVerify ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || tailscaleChecking}
              onClick={verifyTailscale}
            >
              {t("settings.ownerRemote.tailscaleVerify", {
                defaultValue: "Verify connection",
              })}
            </Button>
          ) : null}
        </div>
        {verified ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.ownerRemote.tailscaleEnrollDevice")}
          </p>
        ) : null}
      </section>
      {enabled && running ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.ownerRemote.listenerOnly")}
        </p>
      ) : null}
      {!enabled && !normalizedOrigin ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.ownerRemote.setupRequired", {
            defaultValue:
              "Set up a private HTTPS website below before turning on remote access.",
          })}
        </p>
      ) : null}
      <details className="space-y-3" open={!status?.httpsOrigin || enabled}>
        <summary className="cursor-pointer text-sm">
          {t("settings.ownerRemote.setup")}
        </summary>
        <div className="space-y-3 pt-2">
          <OwnerRemoteTransportGuide />
          <div className="space-y-1">
            <Label htmlFor="owner-remote-origin">
              {t("settings.ownerRemote.origin")}
            </Label>
            <Input
              id="owner-remote-origin"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={origin}
              placeholder="https://your-machine.your-tailnet.ts.net"
              disabled={busy}
              readOnly={originPinned}
              aria-describedby={
                originPinned ? "owner-remote-origin-pinned" : undefined
              }
              onChange={(event) => changeOrigin(event.target.value)}
            />
          </div>
          {originPinned ? (
            <p
              id="owner-remote-origin-pinned"
              className="text-xs text-muted-foreground"
            >
              {t("settings.ownerRemote.originPinned", {
                defaultValue:
                  "This deployment is pinned to its HTTPS website. Changing it requires a separate explicit reset and browser re-enrollment; it cannot be changed here.",
              })}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("settings.ownerRemote.security")}
          </p>
          {enabled && !statusUnavailable && !running ? (
            <Button
              size="sm"
              disabled={busy || !normalizedOrigin}
              onClick={start}
            >
              {t("settings.ownerRemote.retryListener", {
                defaultValue: "Retry listener",
              })}
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || statusUnavailable || !running || !normalizedOrigin
              }
              onClick={createInvite}
            >
              {t("settings.ownerRemote.invite")}
            </Button>
          </div>
          {invite ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <Label htmlFor="owner-remote-invite">
                {t("settings.ownerRemote.inviteExpires", {
                  seconds: secondsLeft,
                })}
              </Label>
              <Input
                id="owner-remote-invite"
                readOnly
                value={invite.url}
                autoComplete="off"
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.ownerRemote.inviteWarning")}
              </p>
            </div>
          ) : null}
          {enabled && running && originPinned && normalizedOrigin && !busy ? (
            <div className="space-y-2">
              <p className="break-all text-xs text-muted-foreground">
                {t("settings.ownerRemote.consoleAddress")}: {normalizedOrigin}
                /remote/
              </p>
              <Button size="sm" variant="outline" asChild>
                <a
                  href={`${normalizedOrigin}/remote/`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("settings.ownerRemote.openWebsite")}
                </a>
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("settings.ownerRemote.boundary")}
          </p>
        </div>
      </details>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.ownerRemote.error")}
        </p>
      ) : null}
    </section>
  );
}
