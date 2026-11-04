import { Schema } from "effect";
import type { SettingsStore } from "./settings.ts";
import { handleTrusted, noArgs, type TrustedIpcOptions, withArgs } from "./trusted-ipc.ts";

/**
 * What macOS reports for the login item (`SMAppService.mainApp`), or `unavailable` where this
 * build cannot register one: a development checkout, which would register Electron itself, or a
 * platform other than macOS (ADR 012).
 */
type LoginItemStatus = "enabled" | "requires-approval" | "not-registered" | "not-found" | "unavailable";

/** The choice in Settings › General and what macOS made of it. */
interface LoginItemState {
  readonly openAtLogin: boolean;
  readonly status: LoginItemStatus;
}

/** The slice of Electron's `app` login-item API this module uses, so tests can stand in for macOS. */
export interface LoginItems {
  readonly read: () => { readonly status: string; readonly wasOpenedAtLogin: boolean };
  readonly write: (openAtLogin: boolean) => void;
}

export interface LoginItem {
  /** True when macOS opened the app at login, so it starts without a window. */
  readonly openedAtLogin: boolean;
  readonly state: () => LoginItemState;
  readonly setOpenAtLogin: (openAtLogin: boolean) => LoginItemState;
}

const statuses = new Set<string>(["enabled", "requires-approval", "not-registered", "not-found"]);
const toStatus = (status: string): LoginItemStatus =>
  statuses.has(status) ? (status as LoginItemStatus) : "not-found";

/**
 * Opening at login is on until the user turns it off. On start the app registers itself the first
 * time, and again while the choice is on but macOS has no registration, as when an ad-hoc signed
 * build was refused or the app moved. A registration the user disabled in System Settings reads as
 * `requires-approval` and is left for them to resolve there.
 */
export const makeLoginItem = (options: {
  readonly supported: boolean;
  readonly items: LoginItems;
  readonly settings: SettingsStore;
}): LoginItem => {
  const { supported, items, settings } = options;
  const choice = () => settings.read().openAtLogin ?? true;
  const state = (): LoginItemState => ({
    openAtLogin: choice(),
    status: supported ? toStatus(items.read().status) : "unavailable",
  });

  let openedAtLogin = false;
  if (supported) {
    openedAtLogin = items.read().wasOpenedAtLogin;
    const status = toStatus(items.read().status);
    if (choice() && (status === "not-registered" || status === "not-found")) items.write(true);
  }

  return {
    openedAtLogin,
    state,
    setOpenAtLogin: (openAtLogin) => {
      settings.update({ openAtLogin });
      if (supported) items.write(openAtLogin);
      // Read back rather than assumed: an unsigned build can be refused without an error.
      return state();
    },
  };
};

/** Channels the preload bridge calls; each answers with the current `LoginItemState`. */
export const loginItemChannels = {
  get: "hobbots:login-item:get",
  set: "hobbots:login-item:set",
  openSystemSettings: "hobbots:login-item:open-system-settings",
} as const;

// System Settings › General › Login Items.
export const loginItemsSettingsUrl = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

/** Answers the bridge's calls, only from pages the window is allowed to show. */
export const handleLoginItemIpc = (
  options: TrustedIpcOptions & {
    readonly loginItem: LoginItem;
    readonly openSystemSettings: () => Promise<void>;
  },
) => {
  const { loginItem, openSystemSettings } = options;
  return handleTrusted(options, {
    [loginItemChannels.get]: noArgs(() => loginItem.state()),
    [loginItemChannels.set]: withArgs(Schema.Tuple([Schema.Boolean]), ([openAtLogin]) =>
      loginItem.setOpenAtLogin(openAtLogin),
    ),
    [loginItemChannels.openSystemSettings]: noArgs(async () => {
      await openSystemSettings();
      return loginItem.state();
    }),
  });
};
