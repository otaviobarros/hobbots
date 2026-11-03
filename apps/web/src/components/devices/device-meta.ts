import { type Device, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { formatAgo, formatDay } from "../../lib/format.ts";
import { messages } from "../messages.ts";

const copy = messages.remoteAccess.devices;

/**
 * Where Settings › Devices is read: on the hub itself, or on a connected desktop, which names the hub
 * and tells its own device apart (ADR 025).
 */
export interface DeviceContext {
  /** The hub's name, on a connected desktop. */
  readonly hub?: string;
  /** This computer's own device, on a connected desktop. */
  readonly ownDeviceId?: string;
}

/** The name Settings › Devices shows: the hub's window by what it is, any other device by the name it chose. */
export const deviceName = (device: Device, context: DeviceContext = {}): string => {
  if (device.id !== WINDOW_DEVICE_ID) return device.name;
  return context.hub === undefined ? copy.window : copy.windowOn({ hub: context.hub });
};

/**
 * The line under a device's name: what it uses and runs on, where it was approved from, and when it
 * was last active, or that it was never used since it was allowed. A connected desktop's own device
 * starts with "this Mac".
 */
export const deviceMeta = (device: Device, now: Date, context: DeviceContext = {}): string => {
  if (device.id === WINDOW_DEVICE_ID || device.kind === "window") return copy.windowMeta;
  const fromHub = context.hub === undefined ? copy.fromHub : copy.onHub({ hub: context.hub });
  const where = device.tailscale === null ? fromHub : (device.tailscale.nodeName.split(".")[0] ?? "");
  const when =
    device.lastActiveAt === null
      ? copy.notUsed({ day: formatDay(device.approvedAt) })
      : copy.active({ when: formatAgo(device.lastActiveAt, now) });
  const own = device.id === context.ownDeviceId ? copy.thisMac : "";
  return [own, copy.using[device.kind], device.platform, where, when].filter((part) => part !== "").join(" · ");
};
