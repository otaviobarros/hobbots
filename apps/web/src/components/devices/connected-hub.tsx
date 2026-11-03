import { Button } from "@hobbots/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DesktopConnection } from "../../api/client.ts";
import { messages } from "../messages.ts";

const copy = messages.remoteAccess.connectedHub;

/** The connected desktop's bridge for its hub (ADR 025); undefined on the hub's own window and in a browser. */
export const connectionBridge = globalThis.window?.hobbots?.connection;
type ConnectionBridge = NonNullable<typeof connectionBridge>;

const connectionKey = ["desktop", "connection"] as const;

/**
 * The hub a connected desktop uses, read from the desktop app, never from the hub. Local IPC, so it
 * runs while the hub cannot be reached; undefined outside a connected desktop.
 */
export const useDesktopConnection = () =>
  useQuery({
    queryKey: connectionKey,
    queryFn: () => (connectionBridge as ConnectionBridge).get(),
    enabled: connectionBridge !== undefined,
    networkMode: "always",
  });

/** Both versions once the hub said its own, or this app's alone before it answered. */
export const versionsLine = (view: DesktopConnection): string =>
  view.hubVersion === null
    ? copy.appVersion({ appVersion: view.appVersion })
    : copy.versions({ hub: view.hubName, hubVersion: view.hubVersion, appVersion: view.appVersion });

/**
 * Disconnect…, asked first in place. Disconnect revokes this computer on the hub and forgets the
 * hub here; the app then starts again at setup's first screen, so this page goes with it. Keep or
 * Escape takes the question back with focus on Disconnect….
 */
function DisconnectQuestion({ bridge, hub }: { readonly bridge: ConnectionBridge; readonly hub: string }) {
  const [asking, setAsking] = useState(false);
  // Local IPC that must work while the hub is out of reach too.
  const disconnect = useMutation({ mutationFn: bridge.disconnect, networkMode: "always" });
  const keepButton = useRef<HTMLButtonElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) keepButton.current?.focus();
    else if (wasAsking.current) askButton.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const keep = () => {
    disconnect.reset();
    setAsking(false);
  };
  // Once Disconnect answered, the app is starting again: the question stays until the window goes.
  const busy = disconnect.isPending || disconnect.isSuccess;

  if (!asking) {
    return (
      <Button
        ref={askButton}
        variant="deny"
        size="xs"
        aria-label={copy.disconnectLabel({ hub })}
        onClick={() => setAsking(true)}
      >
        {copy.disconnect}
      </Button>
    );
  }
  return (
    <fieldset
      aria-label={copy.confirm({ hub })}
      disabled={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          keep();
        }
      }}
      className="cut m-0 flex basis-full animate-hb-in flex-wrap items-center gap-2 border-2 border-solid border-rose bg-deep px-3 py-2.5"
    >
      <span className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <span className="text-sm font-bold text-rose">{copy.confirm({ hub })}</span>
        <span className="text-[13px] text-secondary-text">{copy.confirmNote({ hub })}</span>
      </span>
      {disconnect.isError && (
        <span role="alert" className="basis-full text-sm text-rose">
          {copy.failed}
        </span>
      )}
      <Button ref={keepButton} variant="outline" size="sm" onClick={keep}>
        {copy.keep}
      </Button>
      <Button variant="deny" size="sm" onClick={() => disconnect.mutate()}>
        {busy ? copy.disconnecting : copy.confirmDisconnect}
      </Button>
    </fieldset>
  );
}

/**
 * Settings › Devices on a connected desktop (ADR 025): the hub it uses, with its name, address and
 * both versions, and Disconnect. Remote access, the port and HTTPS are left out: they change the
 * hub's network from elsewhere and could cut this computer off.
 */
export function ConnectedHubSettings({ bridge }: { readonly bridge: ConnectionBridge }) {
  const connection = useDesktopConnection();
  const view = connection.data;
  return (
    <>
      <p className="m-0 text-secondary-text">{copy.intro}</p>
      {connection.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {copy.readFailed}
        </p>
      )}
      {view && (
        <>
          <div className="cut flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-2 border-mint-deep bg-card px-3.5 py-3">
            <span
              aria-hidden
              className={`size-2.5 flex-none ${view.state === "connected" ? "bg-mint" : "bg-lantern"}`}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span role="status" className="font-bold wrap-anywhere">
                {view.state === "connected"
                  ? copy.connected({ hub: view.hubName })
                  : copy.notConnected({ hub: view.hubName })}
              </span>
              <span className="font-mono text-[13px] text-secondary-text wrap-anywhere">
                {view.address} · {copy.overTailscale}
              </span>
              <span className="text-[13px] text-secondary-text">{versionsLine(view)}</span>
            </span>
            <DisconnectQuestion bridge={bridge} hub={view.hubName} />
          </div>
          <span className="text-[13px] text-label">{copy.managedThere({ hub: view.hubName })}</span>
        </>
      )}
    </>
  );
}
