import { pairingDeferred } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { waitingDevicesQuery } from "../../api/pairing.ts";
import { formatTime } from "../../lib/time.ts";
import { useNow } from "../inbox/use-now.ts";
import { DeviceRequestCard } from "./device-request.tsx";
import { messages } from "./messages.ts";

const copy = messages.settings;

/**
 * Settings › Devices: every device still waiting to be allowed, those decided later included, each
 * until its request runs out (ADR 021). With none waiting it shows nothing, so the section starts
 * with what is set.
 */
export function WaitingDevices() {
  const waiting = useQuery(waitingDevicesQuery);
  const now = useNow();
  const devices = waiting.data ?? [];
  if (devices.length === 0) return null;
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-2 pt-2">
      <span className="lbl text-xs text-label">{copy.heading}</span>
      {devices.map((device) => {
        const deferred = pairingDeferred(device.request);
        return (
          <div key={device.request.id} className="flex flex-col gap-1">
            {deferred && (
              <span className="text-xs text-label">
                {copy.deferred} · {copy.expires({ time: formatTime(device.request.expiresAt) })}
              </span>
            )}
            <DeviceRequestCard device={device} now={now} canDefer={!deferred} />
          </div>
        );
      })}
    </section>
  );
}
