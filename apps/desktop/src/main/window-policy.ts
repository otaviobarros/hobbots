/**
 * What a Hobbots window may do, kept apart from the window so it can be tested without Electron:
 * how its page is isolated (STD-DESKTOP-001), and where it may go (STD-DESKTOP-004). app-window.ts
 * passes these to Electron.
 */
import type { WebPreferences } from "electron";

/**
 * Every window's page is isolated and sandboxed, with no Node.js, no `<webview>` and the browser's
 * own web security. `additionalArguments` reach the preload script, never the page.
 */
export const appWebPreferences = (preload: string, additionalArguments: ReadonlyArray<string>) =>
  ({
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    // Only for Chromium's own PDF viewer, which the Workbench's Files tab previews PDFs with.
    plugins: true,
    additionalArguments: [...additionalArguments],
  }) satisfies WebPreferences;

/**
 * The address a link opens in the default browser: only one that parses as an `http:` or `https:`
 * URL, given back as parsed. Anything else, such as `file:`, a custom scheme or text that is not a
 * URL, opens nothing.
 */
export const browserUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
};

/** Answers a page's request for a new window: never one, and a web link opens in the browser instead. */
export const windowOpenHandler =
  (openExternal: (url: string) => Promise<void>) =>
  ({ url }: { readonly url: string }) => {
    const external = browserUrl(url);
    if (external !== null) void openExternal(external).catch(() => undefined);
    return { action: "deny" as const };
  };

/** Stops a navigation or a redirect to any page the window may not show. */
export const navigationGuard =
  (isAllowedUrl: (url: string) => boolean) => (event: { preventDefault: () => void }, url: string) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  };
