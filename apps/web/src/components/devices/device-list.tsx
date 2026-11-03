import { type Device, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { approvedDevices, devicesQuery, useRevokeDevice } from "../../api/devices.ts";
import { useNow } from "../inbox/use-now.ts";
import { messages } from "../messages.ts";
import { deviceMeta, deviceName } from "./device-meta.ts";

const copy = messages.remoteAccess.devices;

/**
 * One allowed device. Revoke… asks first, in the row; Revoke then signs it out at once, and Keep or
 * Escape takes the question back with focus on Revoke…. The hub's window is never revoked.
 */
function DeviceRow({ device, now }: { device: Device; now: Date }) {
  const [asking, setAsking] = useState(false);
  const revoke = useRevokeDevice();
  const name = deviceName(device);
  const keepButton = useRef<HTMLButtonElement>(null);
  const revokeButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) keepButton.current?.focus();
    else if (wasAsking.current) revokeButton.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const keep = () => {
    revoke.reset();
    setAsking(false);
  };

  return (
    <li
      data-device={device.id}
      className="flex flex-col gap-2 border-b-2 border-line py-2.5 last:border-b-0"
      onKeyDown={(event) => {
        if (asking && event.key === "Escape" && !revoke.isPending) {
          event.stopPropagation();
          keep();
        }
      }}
    >
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-bold wrap-anywhere">{name}</span>
          <span className="text-[13px] text-secondary-text wrap-anywhere">{deviceMeta(device, now)}</span>
        </span>
        {device.id !== WINDOW_DEVICE_ID && !asking && (
          <Button
            ref={revokeButton}
            variant="deny"
            size="xs"
            aria-label={copy.revokeLabel({ name })}
            onClick={() => setAsking(true)}
          >
            {copy.revoke}
          </Button>
        )}
      </div>
      {asking && (
        <fieldset
          aria-label={copy.confirm({ name })}
          disabled={revoke.isPending}
          className="cut m-0 flex animate-hb-in flex-wrap items-center gap-2 border-2 border-solid border-rose bg-deep px-3 py-2.5"
        >
          <span className="flex-1 text-sm text-rose">{copy.confirm({ name })}</span>
          {revoke.isError && (
            <span role="alert" className="basis-full text-sm text-rose">
              {copy.revokeFailed}
            </span>
          )}
          <Button ref={keepButton} variant="outline" size="sm" onClick={keep}>
            {copy.keep}
          </Button>
          <Button variant="deny" size="sm" onClick={() => revoke.mutate(device.id)}>
            {revoke.isPending ? copy.revoking : copy.confirmRevoke}
          </Button>
        </fieldset>
      )}
    </li>
  );
}

/** The devices a restore revoked (ADR 026), so you know which to pair again. */
function RevokedByRestore({ devices }: { devices: ReadonlyArray<Device> }) {
  const revoked = devices.filter((device) => device.revokedAt !== null && device.revokedReason === "restore");
  if (revoked.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 pt-2">
      <span className="lbl text-xs text-label">{copy.revokedByRestore}</span>
      <ul className="m-0 flex list-none flex-col p-0">
        {revoked.map((device) => (
          <li key={device.id} className="flex flex-col gap-0.5 border-b-2 border-line py-2 opacity-70 last:border-b-0">
            <span className="font-bold wrap-anywhere">{deviceName(device)}</span>
            <span className="text-[13px] text-secondary-text">{copy.pairAgain}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Settings › Devices: every device that may reach the hub, with its last activity and Revoke (ADR 021).
 * The list follows the journal, so a device allowed or revoked anywhere shows here at once.
 */
export function DeviceList() {
  const devices = useQuery(devicesQuery);
  const now = useNow();
  const headingId = useId();
  // A group rather than a region of its own, so the Devices panel stays the one region named for devices.
  return (
    <div className="flex flex-col gap-1 pt-2">
      <span id={headingId} className="lbl text-xs text-label">
        {copy.heading}
      </span>
      {devices.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {copy.failed}
        </p>
      )}
      {devices.data && (
        <ul aria-labelledby={headingId} className="m-0 flex list-none flex-col p-0">
          {approvedDevices(devices.data).map((device) => (
            <DeviceRow key={device.id} device={device} now={now} />
          ))}
        </ul>
      )}
      {devices.data && <RevokedByRestore devices={devices.data} />}
      <span className="pt-1.5 text-[13px] text-label">{copy.footer}</span>
    </div>
  );
}
