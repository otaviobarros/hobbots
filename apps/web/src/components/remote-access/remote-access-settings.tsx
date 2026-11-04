import { httpsAddress, type RemoteAccessStatus } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { remoteAccessQuery, useUpdateRemoteAccess } from "../../api/remote-access.ts";
import { HttpsSettings, ServeLeftOver } from "../devices/https-settings.tsx";
import { PortField } from "../devices/port-field.tsx";
import { RemoteAddress } from "../devices/remote-address.tsx";
import { messages } from "../messages.ts";
import { TAILSCALE_DOWNLOAD } from "./tailscale-not-ready.tsx";

const copy = messages.remoteAccess;

/** Why the hub is not on the tailnet, in the words Settings uses; null while it listens everywhere. */
export const remoteAccessWhy = (status: RemoteAccessStatus): string | null => {
  switch (status.problem) {
    case null:
    case "off":
      return null;
    case "tailscale":
      return status.tailscale === null || status.tailscale.state === "running"
        ? copy.why.notRunning
        : copy.why[status.tailscale.state];
    case "paused":
      return copy.why.paused;
    case "noAddress":
      return copy.why.noAddress;
    case "cannotListen":
      return copy.why.cannotListen({ detail: status.detail ?? "the port is in use" });
  }
};

/**
 * The address other devices type: the HTTPS address while Tailscale serves the hub there (ADR 021),
 * else the hub's MagicDNS name, or else its first tailnet address, at its port.
 */
export const remoteAddress = (status: RemoteAccessStatus): string | null => {
  const host = status.tailscale?.dnsName ?? status.listening[0];
  if (host === undefined || status.listening.length === 0) return null;
  const secure = httpsAddress(status);
  if (secure !== null) return secure;
  return `http://${host.includes(":") ? `[${host}]` : host}:${status.port}`;
};

/** The hub's short name on the tailnet: its MagicDNS name's first label, or else its first tailnet address. */
export const tailnetName = (status: RemoteAccessStatus): string =>
  status.tailscale?.dnsName?.split(".")[0] ?? status.tailscale?.addresses[0] ?? "";

/** Where the hub is on the tailnet, or why it is not there, once remote access is on. */
function RemoteAccessState({
  status,
  onResume,
  resuming,
}: {
  readonly status: RemoteAccessStatus;
  readonly onResume: () => void;
  readonly resuming: boolean;
}) {
  const why = remoteAccessWhy(status);
  if (why !== null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="status" className="m-0 flex items-start gap-2 text-ui">
          <span aria-hidden className="mt-1.5 size-2 flex-none bg-lantern" />
          <span>{why}</span>
        </p>
        {status.problem === "paused" && (
          <Button variant="outline" size="sm" disabled={resuming} onClick={onResume}>
            {copy.resume}
          </Button>
        )}
      </div>
    );
  }
  const address = remoteAddress(status);
  if (address === null) return null;
  return (
    <div className="flex animate-hb-in flex-col gap-2">
      <p role="status" className="m-0 flex items-center gap-2 text-ui">
        <span aria-hidden className="size-2 flex-none bg-mint" />
        <span>
          {copy.connected} <b>{tailnetName(status)}</b>
        </span>
      </p>
      <RemoteAddress address={address} label={copy.address}>
        <span className="text-detail text-label">{copy.addressNote}</span>
        <PortField port={status.port} />
      </RemoteAddress>
    </div>
  );
}

/** How often a screen that waits for Tailscale asks the hub again, while Tailscale is not running. */
const TAILSCALE_CHECK_MS = 5000;

/**
 * Remote access as a switch, shared by setup and Settings › Devices: the hub's status, and the value
 * the switch shows while a change is on its way. While remote access is off the hub asks Tailscale
 * only when asked, so `watchTailscale` asks again every few seconds until Tailscale runs.
 */
export const useRemoteAccessSwitch = ({ watchTailscale = false }: { readonly watchTailscale?: boolean } = {}) => {
  const access = useQuery({
    ...remoteAccessQuery,
    refetchInterval: (query) =>
      watchTailscale && query.state.data?.tailscale?.state !== "running" ? TAILSCALE_CHECK_MS : false,
  });
  const change = useUpdateRemoteAccess();
  const status = access.data;
  const on = (change.isPending ? change.variables.enabled : undefined) ?? status?.enabled ?? false;
  return { access, change, status, on } as const;
};

/** What Settings says while remote access is off and Tailscale is not ready to carry it; null when it is. */
export const tailscaleNotReady = (status: RemoteAccessStatus): string | null => {
  const state = status.tailscale?.state;
  return state === undefined || state === "running" ? null : copy.notReady[state];
};

/** Settings › Devices: remote access over Tailscale, and why the hub is not on the tailnet when it is not (ADR 021). */
export function RemoteAccessSettings() {
  const labelId = useId();
  const { access, change, status, on } = useRemoteAccessSwitch();
  const notReady = status !== undefined && !status.enabled ? tailscaleNotReady(status) : null;

  return (
    <>
      <p className="m-0 text-text-secondary">{copy.intro}</p>
      <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
        <Switch
          aria-labelledby={labelId}
          checked={on}
          disabled={!status || change.isPending}
          onCheckedChange={(enabled) => change.mutate({ enabled })}
        />
        <div className="flex flex-1 flex-col gap-0.5">
          <span id={labelId} className="font-bold">
            {copy.switchLabel}
          </span>
          <span className="text-detail text-text-secondary">{on ? copy.onNote : copy.offNote}</span>
        </div>
      </div>
      {notReady !== null && (
        <p className="m-0 flex items-start gap-2 text-ui">
          <span aria-hidden className="mt-1.5 size-2 flex-none bg-lantern" />
          <span>
            {notReady}{" "}
            {status?.tailscale?.state === "notInstalled" && (
              <a
                href={TAILSCALE_DOWNLOAD}
                target="_blank"
                rel="noreferrer"
                className="text-text-secondary hover:text-text-strong hover:decoration-current"
              >
                {copy.getTailscale}
              </a>
            )}
          </span>
        </p>
      )}
      {status?.enabled && (
        <>
          <RemoteAccessState
            status={status}
            resuming={change.isPending}
            onResume={() => change.mutate({ paused: false })}
          />
          <HttpsSettings status={status} />
        </>
      )}
      {status !== undefined && <ServeLeftOver status={status} />}
      {(access.isError || change.isError) && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.failed}
        </p>
      )}
    </>
  );
}
