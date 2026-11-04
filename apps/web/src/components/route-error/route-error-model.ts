import { ApiError } from "../../api/client.ts";
import { accessAfter } from "../../api/live.ts";

/**
 * Why a route failed, as far as the client can tell: the hub gave no answer, the thing the address
 * names is gone, or anything else, such as a bug in the page. Each has its own words (STD-UI-009).
 */
export type RouteFailure = "unreachable" | "missing" | "unknown";

export const failureOf = (error: unknown): RouteFailure => {
  if (accessAfter(error) === "unreachable") return "unreachable";
  if (error instanceof ApiError && error.tag?.endsWith("NotFound") === true) return "missing";
  return "unknown";
};

/** The place an error screen offers as the way out, nearest to where the user was. */
export type WayOut = "home" | "hobs" | "inbox" | "archive" | "settings" | "welcome";

export const WAY_OUT_PATHS = {
  home: "/",
  hobs: "/hobs",
  inbox: "/inbox",
  archive: "/archive",
  settings: "/settings",
  welcome: "/welcome",
} as const satisfies Record<WayOut, string>;
