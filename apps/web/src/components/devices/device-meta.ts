import { type Device, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { formatAgo, formatDay } from "../../lib/format.ts";
import { messages } from "../messages.ts";

const copy = messages.remoteAccess.devices;

/** The name Settings › Devices shows: the hub's window by what it is, any other device by the name it chose. */
export const deviceName = (device: Device): string => (device.id === WINDOW_DEVICE_ID ? copy.window : device.name);

/**
 * The line under a device's name: what it uses and runs on, where it was approved from, and when it
 * was last active, or that it was never used since it was allowed.
 */
export const deviceMeta = (device: Device, now: Date): string => {
  if (device.id === WINDOW_DEVICE_ID || device.kind === "window") return copy.windowMeta;
  const where = device.tailscale === null ? copy.fromHub : (device.tailscale.nodeName.split(".")[0] ?? "");
  const when =
    device.lastActiveAt === null
      ? copy.notUsed({ day: formatDay(device.approvedAt) })
      : copy.active({ when: formatAgo(device.lastActiveAt, now) });
  return [copy.using[device.kind], device.platform, where, when].filter((part) => part !== "").join(" · ");
};
