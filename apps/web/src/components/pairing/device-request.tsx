import type { WaitingDevice } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { type PairingDecision, useDecidePairing } from "../../api/pairing.ts";
import { formatWhen } from "../../lib/time.ts";
import { askedFrom, groupedCode, usingText } from "./device-request-model.ts";
import { messages } from "./messages.ts";

const copy = messages.prompt;

/** The device's name, what it uses, where it asked from and when, as plain text: its name is untrusted. */
export function DeviceFacts({ device, now }: { device: WaitingDevice; now: Date }) {
  const rows = [
    [copy.facts.device, device.request.name],
    [copy.facts.using, usingText(device)],
    [copy.facts.tailscale, askedFrom(device)],
    [copy.facts.asked, formatWhen(device.request.createdAt, now)],
  ] as const;
  return (
    <dl className="m-0 flex flex-col">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[110px_1fr] gap-3 border-b-2 border-line py-1.5 text-ui">
          <dt className="text-label">{label}</dt>
          <dd className="m-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The code the device shows too, so the user can match the two screens. It is not a secret. */
export function MatchingCode({ device }: { device: WaitingDevice }) {
  return (
    <div className="cut flex items-center gap-4 bg-text-strong px-4 py-3 text-ground">
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="lbl text-meta">{copy.matchLabel}</span>
        <span className="text-ui">{copy.matchHint({ name: device.request.name })}</span>
      </div>
      <span className="font-heading text-3xl font-bold tracking-[0.12em] whitespace-nowrap">
        {groupedCode(device.request.code)}
      </span>
    </div>
  );
}

/**
 * Allow, Deny and, while the request is still prompted, Decide later. `onDecided` runs once the hub
 * took the answer, so a prompt can close.
 */
export function PairingActions({
  device,
  canDefer,
  onDecided,
}: {
  device: WaitingDevice;
  canDefer: boolean;
  onDecided?: (decision: PairingDecision) => void;
}) {
  const decide = useDecidePairing(device.request);
  const answer = (decision: PairingDecision) => decide.mutate(decision, { onSuccess: () => onDecided?.(decision) });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {canDefer && (
          <Button variant="link" size="sm" disabled={decide.isPending} onClick={() => answer("later")}>
            {copy.later}
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="deny" disabled={decide.isPending} onClick={() => answer("deny")}>
          {copy.deny}
        </Button>
        <Button variant="approve" disabled={decide.isPending} onClick={() => answer("allow")}>
          {copy.allow}
        </Button>
      </div>
      {decide.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {copy.failed}
        </p>
      )}
    </div>
  );
}

/** A waiting device in a list, as Needs you and Settings › Devices show it. */
export function DeviceRequestCard({ device, now, canDefer }: { device: WaitingDevice; now: Date; canDefer: boolean }) {
  return (
    <section
      aria-label={copy.label({ name: device.request.name })}
      className="cut flex flex-col gap-2.5 border-2 border-lantern bg-card px-3 py-2.5"
    >
      <span className="lbl text-meta text-lantern">{copy.kicker}</span>
      <DeviceFacts device={device} now={now} />
      <MatchingCode device={device} />
      <PairingActions device={device} canDefer={canDefer} />
    </section>
  );
}
