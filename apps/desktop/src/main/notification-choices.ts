import type { SettingsStore } from "./settings.ts";
import { handleTrusted, type SettingsIpcOptions } from "./trusted-ipc.ts";

/** Which system notifications the app sends. Each is on until the user turns it off. */
export interface NotificationChoices {
  /** A hob waits for an approval. */
  readonly requests: boolean;
  /** A device asks to connect to this hub (ADR 021). */
  readonly devices: boolean;
  /** Each notification plays the system sound. */
  readonly sound: boolean;
}

export const notificationChoices = (settings: SettingsStore): NotificationChoices => {
  const saved = settings.read();
  return {
    requests: saved.notifyRequests ?? true,
    devices: saved.notifyDevices ?? true,
    sound: saved.notifySound ?? true,
  };
};

/** Channels the preload bridge calls; each answers with the current choices. */
export const notificationChannels = {
  get: "hobbots:notifications:get",
  set: "hobbots:notifications:set",
} as const;

/** Keeps only the known choices that are booleans, so a page can never write anything else. */
const patchFrom = (value: unknown) => {
  if (typeof value !== "object" || value === null) return {};
  const { requests, devices, sound } = value as Record<string, unknown>;
  return {
    ...(typeof requests === "boolean" ? { notifyRequests: requests } : {}),
    ...(typeof devices === "boolean" ? { notifyDevices: devices } : {}),
    ...(typeof sound === "boolean" ? { notifySound: sound } : {}),
  };
};

/** Answers the bridge's calls, only from pages the window is allowed to show. */
export const handleNotificationIpc = (options: SettingsIpcOptions) =>
  handleTrusted(options, {
    [notificationChannels.get]: () => notificationChoices(options.settings),
    [notificationChannels.set]: (patch) => {
      options.settings.update(patchFrom(patch));
      return notificationChoices(options.settings);
    },
  });

type Notify = (notice: { title: string; body: string; silent: boolean }, onClick: () => void) => { close: () => void };

/**
 * Shows a notification of one kind only while that kind is on, read at the moment it would show,
 * and silent when the sound is off. A notification left unshown still counts as handled, so turning
 * the kind on again never announces what already waited.
 */
export const notifyWhenOn =
  (kind: "requests" | "devices", choices: () => NotificationChoices, show: Notify) =>
  (notice: { title: string; body: string }, onClick: () => void): { close: () => void } => {
    const now = choices();
    if (!now[kind]) return { close: () => {} };
    return show({ ...notice, silent: !now.sound }, onClick);
  };
