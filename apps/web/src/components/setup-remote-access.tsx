import type { RemoteAccessStatus } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useId } from "react";
import { setupQuery } from "../api/setup.ts";
import { RemoteAddress } from "./devices/remote-address.tsx";
import { messages } from "./messages.ts";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { builtPreview } from "./onboarding-preview.ts";
import { useFirstHobDraft } from "./onboarding-safety.tsx";
import { remoteAccessWhy, remoteAddress, tailnetName, useRemoteAccessSwitch } from "./remote-access-settings.tsx";
import { TailscaleNotReady } from "./tailscale-not-ready.tsx";

const copy = messages.remoteSetup;

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
        <span className="text-[13px] leading-normal text-text-secondary">{copy.addressNote}</span>
        <span className="text-[13px] text-label">{copy.portNote}</span>
      </RemoteAddress>
    </div>
  );
}

/** What the Chief says on Other devices: pleased once it is on, else whether Tailscale is ready. */
const devicesSpeech = (on: boolean, tailscale: RemoteAccessStatus["tailscale"] | null) => {
  if (on) return copy.elder.on;
  return tailscale === null || tailscale.state === "running" ? copy.elder.ready : copy.elder.missing;
};

/**
 * Setup's optional step after Folders (ADR 021): use Hobbots from your other devices over
 * Tailscale. The switch turns remote access on at once, as in Settings › Devices; Skip for now
 * leaves it off. Either way setup goes on to Ready.
 */
export function SetupRemoteAccess() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const draft = useFirstHobDraft();
  const setup = useQuery(setupQuery);
  const labelId = useId();
  const noteId = useId();
  const { access, change, status, on } = useRemoteAccessSwitch({ watchTailscale: true });
  const tailscale = status?.tailscale ?? null;
  const ready = tailscale?.state === "running";

  const next = () => void navigate({ to: "/setup/ready" });
  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/folders" }));
  // Skip leaves remote access off: it moves on only once the hub says so, and stays here when it
  // cannot. Before the status is read it asks the hub anyway, since turning it off twice is harmless.
  const skip = () => {
    if (status?.enabled === false) return next();
    change.mutate({ enabled: false }, { onSuccess: next });
  };

  return (
    <OnboardingFrame
      step={3}
      extra
      preview={builtPreview(setup.data, draft, 4, devicesSpeech(on, tailscale), {
        caption: on ? copy.captionOn : copy.captionOff,
        remoteOn: on,
      })}
      footer={
        <>
          <span className="flex-1 text-sm text-text-secondary">{on ? copy.hintOn : copy.hintOff}</span>
          <Button variant="outline" onClick={back} disabled={change.isPending}>
            {copy.back}
          </Button>
          <Button variant="outline" disabled={change.isPending} onClick={skip}>
            {copy.skip}
          </Button>
          <Button asChild>
            <Link to="/setup/ready">{copy.continue}</Link>
          </Button>
        </>
      }
    >
      <div className="flex animate-hb-in flex-col gap-1.5">
        <h1 className="m-0 font-heading text-[30px] font-bold text-moonlight">{copy.title}</h1>
        <p className="m-0 mb-3.5 max-w-[660px] text-text-secondary">{copy.intro}</p>
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
                <span className="text-[13px] text-text-secondary">
                  {copy.thisComputer({ name: tailnetName(status) })}
                </span>
              </span>
            </div>
            <div className="flex items-center gap-4 border-b-2 border-line py-3">
              <span className="flex flex-1 flex-col gap-0.5">
                <span id={labelId} className="font-bold">
                  {copy.switchLabel}
                </span>
                <span id={noteId} className="text-[13px] text-text-secondary">
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
    </OnboardingFrame>
  );
}
