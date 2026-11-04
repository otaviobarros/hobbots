import { Schema } from "effect";
import type { SettingsStore } from "./settings.ts";
import { handleTrusted, noArgs, type SettingsIpcOptions, withArgs } from "./trusted-ipc.ts";

/** Which system notifications the app sends. Each is on until the user turns it off. */
export interface NotificationChoices {
  /** A hob needs you: it waits for an approval, a question reached you, or a member's Task failed (ADR 027). */
  readonly requests: boolean;
  /** A device asks to connect to this hub (ADR 021). */
  readonly devices: boolean;
  /** A Quest finished (ADR 027). */
  readonly finishes: boolean;
  /** Each notification plays the system sound. */
  readonly sound: boolean;
}

export const notificationChoices = (settings: SettingsStore): NotificationChoices => {
  const saved = settings.read();
  return {
    requests: saved.notifyRequests ?? true,
    devices: saved.notifyDevices ?? true,
    finishes: saved.notifyFinishes ?? true,
    sound: saved.notifySound ?? true,
  };
};

/** Channels the preload bridge calls; each answers with the current choices. */
export const notificationChannels = {
  get: "hobbots:notifications:get",
  set: "hobbots:notifications:set",
} as const;

/** The choices a page changes: only the known ones, each a boolean; any other key is dropped. */
const ChoicesPatch = () =>
  Schema.Struct({
    requests: Schema.optionalKey(Schema.Boolean),
    devices: Schema.optionalKey(Schema.Boolean),
    finishes: Schema.optionalKey(Schema.Boolean),
    sound: Schema.optionalKey(Schema.Boolean),
  });

const patchFrom = ({ requests, devices, finishes, sound }: Partial<NotificationChoices>) => ({
  ...(requests !== undefined && { notifyRequests: requests }),
  ...(devices !== undefined && { notifyDevices: devices }),
  ...(finishes !== undefined && { notifyFinishes: finishes }),
  ...(sound !== undefined && { notifySound: sound }),
});

/** Answers the bridge's calls, only from pages the window is allowed to show. */
export const handleNotificationIpc = (options: SettingsIpcOptions) =>
  handleTrusted(options, {
    [notificationChannels.get]: noArgs(() => notificationChoices(options.settings)),
    [notificationChannels.set]: withArgs(Schema.Tuple([ChoicesPatch()]), async ([patch]) => {
      options.settings.update(patchFrom(patch));
      await options.settings.saved();
      return notificationChoices(options.settings);
    }),
  });

type Notify = (notice: { title: string; body: string; silent: boolean }, onClick: () => void) => { close: () => void };

/**
 * Shows a notification of one kind only while that kind is on, read at the moment it would show,
 * and silent when the sound is off. A notification left unshown still counts as handled, so turning
 * the kind on again never announces what already waited.
 */
export const notifyWhenOn =
  (kind: "requests" | "devices" | "finishes", choices: () => NotificationChoices, show: Notify) =>
  (notice: { title: string; body: string }, onClick: () => void): { close: () => void } => {
    const now = choices();
    if (!now[kind]) return { close: () => {} };
    return show({ ...notice, silent: !now.sound }, onClick);
  };
