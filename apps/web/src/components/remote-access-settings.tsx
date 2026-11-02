import type { RemoteAccessStatus } from "@hobbots/domain";
import { Switch } from "@hobbots/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { remoteAccessQuery, useUpdateRemoteAccess } from "../api/remote-access.ts";
import { messages } from "./messages.ts";

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
    case "noAddress":
      return copy.why.noAddress;
    case "cannotListen":
      return copy.why.cannotListen({ detail: status.detail ?? "the port is in use" });
  }
};

/** The address other devices type: the hub's MagicDNS name, or else its first tailnet address, at its port. */
export const remoteAddress = (status: RemoteAccessStatus): string | null => {
  const host = status.tailscale?.dnsName ?? status.listening[0];
  if (host === undefined || status.listening.length === 0) return null;
  return `http://${host.includes(":") ? `[${host}]` : host}:${status.port}`;
};

/** Settings › Devices: remote access over Tailscale, and why the hub is not on the tailnet when it is not (ADR 021). */
export function RemoteAccessSettings() {
  const labelId = useId();
  const access = useQuery(remoteAccessQuery);
  const change = useUpdateRemoteAccess();
  const status = access.data;
  const on = change.isPending ? (change.variables.enabled ?? false) : (status?.enabled ?? false);
  const why = status?.enabled ? remoteAccessWhy(status) : null;
  const address = status ? remoteAddress(status) : null;

  return (
    <>
      <p className="m-0 text-secondary-text">{copy.intro}</p>
      <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
        <div className="flex flex-1 flex-col gap-0.5">
          <span id={labelId} className="font-bold">
            {copy.switchLabel}
          </span>
          <span className="text-[13px] text-secondary-text">{on ? copy.onNote : copy.offNote}</span>
        </div>
        <Switch
          aria-labelledby={labelId}
          checked={on}
          disabled={!status || change.isPending}
          onCheckedChange={(enabled) => change.mutate({ enabled })}
        />
      </div>
      {status?.enabled && why !== null && (
        <p role="status" className="m-0 flex items-start gap-2 text-sm">
          <span aria-hidden className="mt-1.5 size-2 flex-none bg-lantern" />
          <span>{why}</span>
        </p>
      )}
      {status?.enabled && why === null && address !== null && (
        <div className="flex flex-col gap-2">
          <p role="status" className="m-0 flex items-center gap-2 text-sm">
            <span aria-hidden className="size-2 flex-none bg-mint" />
            <span>
              {copy.connected} <b>{status.tailscale?.dnsName?.split(".")[0] ?? status.listening[0]}</b>
            </span>
          </p>
          <span className="lbl pt-1 text-xs text-label">{copy.address}</span>
          <span className="cut border-2 border-control bg-ground px-3 py-2 font-mono text-base font-bold text-moonlight">
            {address}
          </span>
          <span className="text-[13px] text-label">{copy.addressNote}</span>
        </div>
      )}
      {(access.isError || change.isError) && (
        <p role="alert" className="m-0 text-sm text-rose">
          {copy.failed}
        </p>
      )}
    </>
  );
}
