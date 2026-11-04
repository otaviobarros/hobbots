import { Button } from "@hobbots/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DesktopConnection } from "../../api/client.ts";
import { type ConnectionBridge, useDesktopConnection } from "../../api/connected-desktop.ts";
import { messages } from "../messages.ts";

const copy = messages.remoteAccess.connectedHub;

type Disconnect = NonNullable<ConnectionBridge["disconnect"]>;

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
function DisconnectQuestion({ run, hub }: { readonly run: Disconnect; readonly hub: string }) {
  const [asking, setAsking] = useState(false);
  // Local IPC that must work while the hub is out of reach too.
  const disconnect = useMutation({ mutationFn: run, networkMode: "always" });
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
        <span className="text-ui font-bold text-rose">{copy.confirm({ hub })}</span>
        <span className="text-detail text-text-secondary">{copy.confirmNote({ hub })}</span>
      </span>
      {disconnect.isError && (
        <span role="alert" className="basis-full text-ui text-rose">
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
      <p className="m-0 text-text-secondary">{copy.intro}</p>
      {connection.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
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
              <span className="font-mono text-code text-text-secondary wrap-anywhere">
                {view.address} · {copy.overTailscale}
              </span>
              <span className="text-detail text-text-secondary">{versionsLine(view)}</span>
            </span>
            {bridge.disconnect && <DisconnectQuestion run={bridge.disconnect} hub={view.hubName} />}
          </div>
          <span className="text-detail text-label">{copy.managedThere({ hub: view.hubName })}</span>
          {!bridge.disconnect && (
            <span className="text-detail text-label">{copy.updateToDisconnect({ hub: view.hubName })}</span>
          )}
        </>
      )}
    </>
  );
}
