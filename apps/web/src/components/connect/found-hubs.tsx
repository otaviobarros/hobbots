import type { FoundHubView, HubListView } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { useCallback, useEffect, useState } from "react";
import { TailscaleNotReady } from "../tailscale-not-ready.tsx";
import type { SetupBridge } from "./connect-model.ts";
import { messages } from "./messages.ts";

const copy = messages.form;

/** How often Connect looks again while Tailscale is not ready here, as setup's own steps promise. */
const RECHECK_MS = 5000;

type Scan = { readonly kind: "looking" } | { readonly kind: "failed" } | HubListView;

/** The hubs on the user's own computers, read when Connect opens, on Look again, and by itself while Tailscale is not ready. */
const useHubs = (bridge: SetupBridge) => {
  const [scan, setScan] = useState<Scan>({ kind: "looking" });
  const [checking, setChecking] = useState(true);
  const look = useCallback(async () => {
    setChecking(true);
    try {
      setScan(await bridge.findHubs());
    } catch {
      setScan({ kind: "failed" });
    } finally {
      setChecking(false);
    }
  }, [bridge]);
  useEffect(() => {
    void look();
  }, [look]);
  const notReady = scan.kind === "tailscale";
  useEffect(() => {
    if (!notReady) return;
    const timer = setInterval(() => void look(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [notReady, look]);
  return { scan, checking, look };
};

function HubRow({ hub, disabled, onConnect }: { hub: FoundHubView; disabled: boolean; onConnect: () => void }) {
  const usable = hub.support === "supported";
  const details = [hub.address, copy.version({ version: hub.version })];
  if (hub.hubName !== null && hub.hubName !== hub.computer) details.push(copy.calledItself({ name: hub.hubName }));
  return (
    <li className="cut flex items-center gap-3 border-2 border-line-2 bg-card px-3.5 py-3">
      <span aria-hidden className={`size-2.5 flex-none ${usable ? "bg-mint" : "bg-lantern"}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-bold">{hub.computer}</span>
        <span className="truncate font-mono text-[13px] text-secondary-text">{details.join(" · ")}</span>
        {!usable && (
          <span className="text-[13px] text-lantern">
            {hub.support === "hubOlder"
              ? copy.hubOlder({ computer: hub.computer })
              : copy.appOlder({ computer: hub.computer })}
          </span>
        )}
      </span>
      {usable && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label={copy.connectLabel({ computer: hub.computer })}
          onClick={onConnect}
        >
          {copy.use}
        </Button>
      )}
    </li>
  );
}

/**
 * The hubs found on the user's own computers on the tailnet, each with Connect; or, while Tailscale
 * is not ready here, how to get it ready.
 */
export function FoundHubs({
  bridge,
  busy,
  onConnect,
}: {
  bridge: SetupBridge;
  busy: boolean;
  onConnect: (address: string) => void;
}) {
  const { scan, checking, look } = useHubs(bridge);
  if (scan.kind === "tailscale") {
    return <TailscaleNotReady state={scan.state} checking={checking} onCheck={() => void look()} />;
  }
  return (
    <section aria-labelledby="found-hubs" className="flex max-w-[700px] flex-col gap-2 pt-4">
      <span className="flex items-center gap-3">
        <span id="found-hubs" className="lbl flex-1 text-xs text-label">
          {copy.found}
        </span>
        <Button size="sm" variant="ghost" disabled={checking} onClick={() => void look()}>
          {copy.lookAgain}
        </Button>
      </span>
      {scan.kind === "looking" && (
        <p role="status" className="m-0 text-sm text-secondary-text">
          {copy.looking}
        </p>
      )}
      {scan.kind === "failed" && (
        <p role="alert" className="m-0 text-sm text-rose">
          {copy.scanFailed}
        </p>
      )}
      {scan.kind === "hubs" && scan.hubs.length === 0 && (
        <p role="status" className="m-0 text-sm text-secondary-text">
          {copy.none}
        </p>
      )}
      {scan.kind === "hubs" && scan.hubs.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {scan.hubs.map((hub) => (
            <HubRow key={hub.address} hub={hub} disabled={busy} onConnect={() => onConnect(hub.address)} />
          ))}
        </ul>
      )}
      <span className="text-[13px] leading-normal text-label">{copy.notListed}</span>
    </section>
  );
}
