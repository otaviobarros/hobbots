import type { SettingsStore } from "./settings.ts";

/**
 * Drops the window's HTTP cache when the app runs a version other than the one that last ran.
 *
 * The hub asks browsers to check index.html on every load, but a copy cached by an older version
 * never saw that header, so the browser can keep reusing it: after an update the window would run
 * the old web client against the new hub until a reload. Clearing the cache once per version change
 * makes the first window after an update load the new client. Cookies and storage are untouched.
 *
 * A failed clear is logged and tried again on the next launch.
 */
export const dropCachedClientOnUpdate = async (
  version: string,
  settings: SettingsStore,
  clearCache: () => Promise<void>,
) => {
  if (settings.read().appVersion === version) return;
  try {
    await clearCache();
    settings.update({ appVersion: version });
  } catch (error) {
    console.error("Hobbots could not clear the cached web client after an update", error);
  }
};
