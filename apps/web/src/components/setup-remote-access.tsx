import type { RemoteAccessStatus, TailscaleState } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId } from "react";
import { RemoteAddress } from "./devices/remote-address.tsx";
import { messages } from "./messages.ts";
import {
  remoteAccessWhy,
  remoteAddress,
  TAILSCALE_DOWNLOAD,
  tailnetName,
  useRemoteAccessSwitch,
} from "./remote-access-settings.tsx";
import { ElderAside } from "./where-hobbots-runs.tsx";

const copy = messages.remoteSetup;

/** Tailscale is not ready here: how to get it ready, and Check again, which Hobbots also does by itself. */
function TailscaleNotReady({
  state,
  checking,
  onCheck,
}: {
  state: Exclude<TailscaleState, "running">;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <section
      aria-label={copy.missing[state]}
      className="cut flex max-w-[720px] flex-col gap-2.5 border-2 border-lantern bg-card px-[18px] py-4"
    >
      <span className="font-bold">{copy.missing[state]}</span>
      <span className="text-sm leading-normal text-secondary-text">{copy.missingBody}</span>
      <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm leading-normal">
        {copy.steps.map((step, index) => (
          <li key={step}>
            <b className="text-lantern">{index + 1}.</b> {step}
          </li>
        ))}
      </ol>
      <span className="flex flex-wrap gap-2.5 pt-1">
        <Button asChild variant="outline" size="sm">
          <a href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
            {messages.remoteAccess.getTailscale}
          </a>
        </Button>
        <Button variant="outline" size="sm" disabled={checking} onClick={onCheck}>
          {checking ? copy.checking : copy.checkAgain}
        </Button>
      </span>
    </section>
  );
}

/** With remote access on: the address and QR code, or why the hub is not on the tailnet yet. */
function RemoteAccessOn({ status }: { status: RemoteAccessStatus }) {
  const why = remoteAccessWhy(status);
  const address = remoteAddress(status);
  if (why !== null) {
    return (
      <p role="status" className="m-0 flex items-start gap-2 text-sm">
        <span aria-hidden className="mt-1.5 size-2 flex-none bg-lantern" />
        <span>{why}</span>
      </p>
    );
  }
  if (address === null) return null;
  return (
    <div className="animate-hb-in">
      <RemoteAddress address={address} label={copy.address}>
        <span className="text-[13px] leading-normal text-secondary-text">{copy.addressNote}</span>
        <span className="text-[13px] text-label">{copy.portNote}</span>
      </RemoteAddress>
    </div>
  );
}

/**
 * Setup's optional step after "Run Hobbots on this computer" (screen 2, ADR 021): use Hobbots from
 * your other devices over Tailscale. The switch turns remote access on at once, as in Settings ›
 * Devices; Skip for now leaves it off.
 */
export function SetupRemoteAccess() {
  const navigate = useNavigate();
  const labelId = useId();
  const noteId = useId();
  const { access, change, status, on } = useRemoteAccessSwitch({ watchTailscale: true });
  const tailscale = status?.tailscale ?? null;
  const ready = tailscale?.state === "running";

  const skip = () => {
    if (status?.enabled) change.mutate({ enabled: false });
    void navigate({ to: "/setup/providers" });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <ElderAside stage={copy.stage} speech={tailscale === null || ready ? copy.elder.ready : copy.elder.missing} />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-12 pt-10 pb-6">
        <div className="flex min-h-0 flex-1 animate-hb-in flex-col gap-2">
          <span className="lbl text-label">{copy.eyebrow}</span>
          <h1 className="m-0 font-pixel text-[32px] font-bold text-moonlight">{copy.title}</h1>
          <p className="m-0 mb-3.5 max-w-[660px] text-secondary-text">{copy.intro}</p>
          {tailscale !== null && tailscale.state !== "running" && (
            <TailscaleNotReady
              state={tailscale.state}
              checking={access.isFetching}
              onCheck={() => void access.refetch()}
            />
          )}
          {status !== undefined && ready && (
            <div className="flex max-w-[760px] flex-col gap-3.5">
              <div className="cut flex items-center gap-3.5 border-2 border-mint-deep bg-card px-4 py-3">
                <span aria-hidden className="size-2.5 flex-none bg-mint" />
                <span className="flex flex-col gap-0.5">
                  <span className="font-bold">{copy.connected}</span>
                  <span className="text-[13px] text-secondary-text">
                    {copy.thisComputer({ name: tailnetName(status) })}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-4 border-b-2 border-line py-3">
                <span className="flex flex-1 flex-col gap-0.5">
                  <span id={labelId} className="font-bold">
                    {copy.switchLabel}
                  </span>
                  <span id={noteId} className="text-[13px] text-secondary-text">
                    {copy.switchNote}
                  </span>
                </span>
                <Switch
                  aria-labelledby={labelId}
                  aria-describedby={noteId}
                  checked={on}
                  disabled={change.isPending}
                  onCheckedChange={(enabled) => change.mutate({ enabled })}
                />
              </div>
              {status.enabled && <RemoteAccessOn status={status} />}
            </div>
          )}
          {(access.isError || change.isError) && (
            <p role="alert" className="m-0 text-sm text-rose">
              {messages.remoteAccess.failed}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t-2 border-line pt-4">
          <Button asChild variant="outline">
            <Link to="/setup/where">{copy.back}</Link>
          </Button>
          <span className="flex-1 text-end text-sm text-secondary-text">{on ? copy.hintOn : copy.hintOff}</span>
          <Button variant="outline" disabled={change.isPending} onClick={skip}>
            {copy.skip}
          </Button>
          <Button asChild>
            <Link to="/setup/providers">{copy.continue}</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
