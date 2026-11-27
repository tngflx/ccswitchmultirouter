import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

type OwnerRemoteTransport = "tailscale" | "cloudflare" | "teamviewer";

const transportOptions: Array<{
  id: OwnerRemoteTransport;
  labelKey: string;
  label: string;
}> = [
  {
    id: "tailscale",
    labelKey: "settings.ownerRemote.transportTailscale",
    label: "Tailscale (recommended)",
  },
  {
    id: "cloudflare",
    labelKey: "settings.ownerRemote.transportCloudflare",
    label: "Cloudflare Tunnel + Access",
  },
  {
    id: "teamviewer",
    labelKey: "settings.ownerRemote.transportTeamViewer",
    label: "TeamViewer fallback",
  },
];

function TransportPanel({ transport }: { transport: OwnerRemoteTransport }) {
  const { t } = useTranslation();
  const text = (key: string, defaultValue: string) => t(key, { defaultValue });

  if (transport === "tailscale") {
    return (
      <div
        className="space-y-2"
        role="tabpanel"
        id="owner-remote-transport-panel-tailscale"
      >
        <p className="text-xs text-muted-foreground">
          {text(
            "settings.ownerRemote.privateNetwork",
            "Use Tailscale for a private owner website. The host and your tablet/laptop join the same tailnet; the owner service remains on 127.0.0.1:15723.",
          )}
        </p>
        <ol
          aria-label={text(
            "settings.ownerRemote.tailscaleSteps",
            "Private Tailscale setup steps",
          )}
          className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground"
        >
          {[
            "setupStepDevices",
            "setupStepAccess",
            "setupStepServe",
            "setupStepOrigin",
            "setupStepEnroll",
          ].map((step) => (
            <li key={step}>
              {text(
                `settings.ownerRemote.${step}`,
                step === "setupStepDevices"
                  ? "Install and sign in to Tailscale on the host and remote device. Keep the host online."
                  : step === "setupStepAccess"
                    ? "Allow only your authorized tailnet devices to reach this host's HTTPS service. Do not publish model, debug, CDP, or Tauri ports."
                    : step === "setupStepServe"
                      ? "Configure Tailscale Serve to forward private HTTPS to the local owner listener:"
                      : step === "setupStepOrigin"
                        ? "Pin the exact HTTPS origin reported by Serve, then enable owner access."
                        : "Create a one-use enrollment link, open it on your own device within 60 seconds, and register a passkey.",
              )}
              {step === "setupStepServe" ? (
                <pre className="mt-2 overflow-auto rounded-md bg-muted p-2 text-xs">
                  tailscale serve --bg http://127.0.0.1:15723
                </pre>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          {text(
            "settings.ownerRemote.tailscaleTransportBoundary",
            "Tailscale is the private transport; CCSwitch WebAuthn and exact-operation checks still protect the owner website. Opening the listener does not prove that a second device can reach it.",
          )}
        </p>
        <details className="space-y-2">
          <summary className="cursor-pointer text-xs">
            {text(
              "settings.ownerRemote.cloudflareOptional",
              "Optional: Cloudflare domain management only",
            )}
          </summary>
          <div className="space-y-2 pt-2 text-xs text-muted-foreground">
            <p>
              {text(
                "settings.ownerRemote.cloudflareDnsOnly",
                "For Tailscale mode, keep Cloudflare DNS-only and out of the traffic path.",
              )}
            </p>
            <p>
              {text(
                "settings.ownerRemote.cloudflareCertificate",
                "A custom hostname needs its own private HTTPS certificate and explicit origin pinning.",
              )}
            </p>
            <p>
              {text(
                "settings.ownerRemote.cloudflareNoSecrets",
                "Never put Cloudflare credentials or API tokens into CCSwitch.",
              )}
            </p>
          </div>
        </details>
      </div>
    );
  }

  if (transport === "cloudflare") {
    return (
      <div
        className="space-y-2"
        role="tabpanel"
        id="owner-remote-transport-panel-cloudflare"
      >
        <p className="text-xs text-muted-foreground">
          {text(
            "settings.ownerRemote.cloudflareFullDescription",
            "Use this when a tablet should open a normal browser without installing Tailscale. Cloudflare becomes the external DNS, tunnel, and Access identity layer; CCSwitch remains the final WebAuthn and Continue authorization layer.",
          )}
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground">
          <li>
            {text(
              "settings.ownerRemote.cloudflareFullStepTunnel",
              "Create a dedicated Cloudflare Tunnel and run cloudflared on the host as an outbound connector.",
            )}
          </li>
          <li>
            {text(
              "settings.ownerRemote.cloudflareFullStepRoute",
              "Create one published hostname that maps only to http://127.0.0.1:15723. Never route the model API, debug/CDP, Tauri IPC, SQLite, or takeover ports.",
            )}
          </li>
          <li>
            {text(
              "settings.ownerRemote.cloudflareFullStepAccess",
              "Create a Cloudflare Access self-hosted application first, deny by default, allow only your identity, and require MFA. Keep CCSwitch passkeys enabled as defense in depth.",
            )}
          </li>
          <li>
            {text(
              "settings.ownerRemote.cloudflareFullStepOrigin",
              "Pin the final https:// hostname in CCSwitch, then create the one-use enrollment link and register your remote passkey.",
            )}
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild>
            <a
              href="https://dash.cloudflare.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              {text(
                "settings.ownerRemote.cloudflareDashboard",
                "Open Cloudflare dashboard",
              )}
            </a>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a
              href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
              target="_blank"
              rel="noopener noreferrer"
            >
              {text(
                "settings.ownerRemote.cloudflareDocs",
                "Read Cloudflare Tunnel guide",
              )}
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {text(
            "settings.ownerRemote.cloudflareFullBoundary",
            "Do not paste Cloudflare API tokens, tunnel tokens, IdP secrets, or account credentials into CCSwitch. Configure the tunnel outside the app and store any connector secret in the cloudflared service/OS secret store.",
          )}
        </p>
      </div>
    );
  }

  return (
    <div
      className="space-y-2"
      role="tabpanel"
      id="owner-remote-transport-panel-teamviewer"
    >
      <p className="text-xs text-muted-foreground">
        {text(
          "settings.ownerRemote.teamViewerDescription",
          "Use TeamViewer only when you need to see or control the whole host desktop. It is not the CCSwitch transcript or Continue transport.",
        )}
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground">
        <li>
          {text(
            "settings.ownerRemote.teamViewerStepAccess",
            "On the host, configure TeamViewer Host/full client for unattended access or Easy Access, assigned only to your account.",
          )}
        </li>
        <li>
          {text(
            "settings.ownerRemote.teamViewerStepSecurity",
            "Enable TeamViewer account 2FA and an allowlist; disable random/personal passwords when your account-only setup is ready.",
          )}
        </li>
        <li>
          {text(
            "settings.ownerRemote.teamViewerStepUse",
            "Open the TeamViewer web client from your tablet/laptop for emergency desktop rescue. Use the CCSwitch owner website for Continue so the operation remains signed and idempotent.",
          )}
        </li>
      </ol>
      <p className="text-xs text-destructive">
        {text(
          "settings.ownerRemote.teamViewerWarning",
          "TeamViewer grants broad screen and keyboard/mouse access and can expose other host secrets. Do not automate clicks through it or store TeamViewer credentials in CCSwitch.",
        )}
      </p>
      <Button size="sm" variant="outline" asChild>
        <a
          href="https://web.teamviewer.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {text(
            "settings.ownerRemote.teamViewerOpen",
            "Open TeamViewer web client",
          )}
        </a>
      </Button>
    </div>
  );
}

export function OwnerRemoteTransportGuide() {
  const { t } = useTranslation();
  const [transport, setTransport] = useState<OwnerRemoteTransport>("tailscale");
  const tabListId = useId();
  const text = (key: string, defaultValue: string) => t(key, { defaultValue });

  return (
    <section
      className="space-y-3 border-t border-border/70 pt-3"
      aria-labelledby="owner-remote-transport-title"
    >
      <div className="space-y-1">
        <h4 id="owner-remote-transport-title" className="text-sm font-medium">
          {text(
            "settings.ownerRemote.transportTitle",
            "Choose how your remote device reaches this host",
          )}
        </h4>
        <p className="text-xs text-muted-foreground">
          {text(
            "settings.ownerRemote.transportDescription",
            "The CCSwitch owner service stays bound to 127.0.0.1:15723. Choose exactly one transport; do not combine tunnels or expose the other local ports.",
          )}
        </p>
      </div>
      <div
        id={tabListId}
        role="tablist"
        aria-label={text(
          "settings.ownerRemote.transportTitle",
          "Choose how your remote device reaches this host",
        )}
        className="flex flex-wrap gap-2"
      >
        {transportOptions.map((option) => {
          const selected = transport === option.id;
          return (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              role="tab"
              aria-selected={selected}
              aria-controls={`owner-remote-transport-panel-${option.id}`}
              onClick={() => setTransport(option.id)}
            >
              {text(option.labelKey, option.label)}
            </Button>
          );
        })}
      </div>
      <TransportPanel transport={transport} />
    </section>
  );
}
