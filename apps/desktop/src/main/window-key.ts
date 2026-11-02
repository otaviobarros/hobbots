/**
 * The hub's window key (ADR 021): the hub writes a fresh one to the data folder on every start, and
 * this app, which can read that folder, is the only client trusted without asking. The main process
 * sends it as a bearer token and sets it as the window's session cookie; it reads the file again
 * after the server restarts or answers 401. Electron stays out of this file; index.ts passes it in.
 */
import { readFileSync } from "node:fs";
import { windowKeyFile } from "@hobbots/server/window-key";

/** The cookie the window's pages carry: the same name a paired browser's device cookie has. */
export const WINDOW_COOKIE = "hobbots_device";

export interface WindowKey {
  /** The key as last read; undefined while the hub has written none. */
  readonly current: () => string | undefined;
  /** Reads the file again, as after a restart or a 401. */
  readonly reload: () => string | undefined;
  /** The headers that make a main-process request the window's. */
  readonly headers: () => Record<string, string>;
}

export const makeWindowKey = (
  dataDir: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
) => {
  let key: string | undefined;
  const reload = () => {
    try {
      key = read(windowKeyFile(dataDir)).trim() || undefined;
    } catch {
      key = undefined;
    }
    return key;
  };
  const current = () => key ?? reload();
  const window: WindowKey = {
    current,
    reload,
    headers: (): Record<string, string> => {
      const value = current();
      return value === undefined ? {} : { authorization: `Bearer ${value}` };
    },
  };
  return window;
};

/**
 * Fetches from the hub as the window. On a 401 the hub may have restarted with a new key, so it reads
 * the key again, tells `onNewKey` (to set the window's cookie again) and tries once more.
 */
export const fetchAsWindow =
  (key: WindowKey, onNewKey: () => void, fetcher: typeof globalThis.fetch = globalThis.fetch) =>
  async (url: string, init: RequestInit = {}): Promise<Response> => {
    const send = () =>
      fetcher(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...key.headers() } });
    const response = await send();
    if (response.status !== 401) return response;
    const before = key.current();
    if (key.reload() === before) return response;
    onNewKey();
    return send();
  };
