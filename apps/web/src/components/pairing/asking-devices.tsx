import type { WaitingDevice } from "@hobbots/api";
import { DeviceRequestCard } from "./device-request.tsx";
import { messages } from "./messages.ts";

const copy = messages.needsYou;

/** Devices asking to pair, first in Needs you on every approved device, each with Allow, Deny and Decide later. */
export function AskingDevices({ devices, now }: { devices: ReadonlyArray<WaitingDevice>; now: Date }) {
  if (devices.length === 0) return null;
  return (
    <section aria-label={copy.section} className="flex flex-col gap-2 px-2.5 pt-2.5 pb-1">
      <span className="lbl text-xs text-label">{copy.count({ count: devices.length })}</span>
      {devices.map((device) => (
        <DeviceRequestCard key={device.request.id} device={device} now={now} canDefer />
      ))}
    </section>
  );
}
