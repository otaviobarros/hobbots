/**
 * The connected desktop's window cookies (ADR 025). The main process sets the device token as an
 * `HttpOnly`, `SameSite=Strict` session cookie for each of the hub's origins, and keeps the hub's
 * 400-day refresh of it out of the window's cookie store, so the token never reaches the disk.
 * Electron stays out of this file; connected-mode.ts applies these to the window's session.
 */
import type { HubOrigins, WindowRequestVerdict } from "./hub-connection.ts";

/** The device cookie over plain HTTP, and its `__Host-` twin over HTTPS, as the hub names them. */
export const DEVICE_COOKIE = "hobbots_device";
export const SECURE_DEVICE_COOKIE = "__Host-hobbots_device";
const DEVICE_COOKIES = new Set([DEVICE_COOKIE, SECURE_DEVICE_COOKIE]);

/** A cookie as Electron's `cookies.set` takes it. No expiry: a session cookie, never written to disk. */
export interface WindowCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "strict";
  readonly path: "/";
}

/** The two device cookies for the hub's origins, with no `Domain`, so each stays on the hub's host. */
export const deviceCookies = (origins: HubOrigins, token: string): ReadonlyArray<WindowCookie> => [
  {
    url: `${origins.http}/`,
    name: DEVICE_COOKIE,
    value: token,
    httpOnly: true,
    secure: false,
    sameSite: "strict",
    path: "/",
  },
  {
    url: `${origins.https}/`,
    name: SECURE_DEVICE_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
  },
];

/** The cookie a `Set-Cookie` line sets. */
const cookieName = (line: string) => line.slice(0, Math.max(0, line.indexOf("="))).trim();

/**
 * The hub's answer headers without any `Set-Cookie` for the device cookies: the hub refreshes them
 * with its 400-day lifetime, which would write the token to disk. Other cookies pass untouched.
 */
export const withoutDeviceCookies = (
  headers: Readonly<Record<string, ReadonlyArray<string>>>,
): Record<string, Array<string>> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, values]) => {
      if (name.toLowerCase() !== "set-cookie") return [[name, [...values]]];
      const kept = values.filter((line) => !DEVICE_COOKIES.has(cookieName(line)));
      return kept.length === 0 ? [] : [[name, kept]];
    }),
  );

/** A request's `Cookie` header without the device cookies, for a request that must not carry the token. */
const withoutDeviceCookieHeader = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (name.toLowerCase() !== "cookie") return [[name, value]];
      const kept = value
        .split(";")
        .map((pair) => pair.trim())
        .filter((pair) => pair !== "" && !DEVICE_COOKIES.has(cookieName(pair)));
      return kept.length === 0 ? [] : [[name, kept.join("; ")]];
    }),
  );

/** The part of Electron's `webRequest` the guard uses, so a test can drive it without Electron. */
export interface BeforeSendHeaders {
  readonly onBeforeSendHeaders: (
    listener: (
      details: { readonly url: string; readonly requestHeaders: Record<string, string> },
      callback: (response: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void,
    ) => void,
  ) => void;
}

/**
 * Puts every request of the window through the gate before the browser engine sends it, page loads
 * and reloads included: a request to the hub's origins while its address is not the pinned node's is
 * cancelled, so it carries no token and loads no page, and `onRefused` checks the connection again.
 */
export const guardWindowRequests = (
  webRequest: BeforeSendHeaders,
  gate: (url: string) => Promise<WindowRequestVerdict>,
  onRefused: () => void,
) =>
  webRequest.onBeforeSendHeaders((details, callback) => {
    void gate(details.url)
      .catch((): WindowRequestVerdict => "cancel")
      .then((verdict) => {
        if (verdict === "cancel") {
          onRefused();
          return callback({ cancel: true });
        }
        if (verdict === "withoutToken")
          return callback({ requestHeaders: withoutDeviceCookieHeader(details.requestHeaders) });
        callback({});
      });
  });
