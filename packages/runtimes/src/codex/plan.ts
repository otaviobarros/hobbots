import { type PlanMeter, type PlanUsage, unreportedPlan } from "@hobbots/domain";
import type { AppServer } from "./app-server.ts";
import type { GetAccountRateLimitsResponse, RateLimitSnapshot, RateLimitWindow } from "./protocol.ts";

// A ChatGPT plan's limits as Codex reports them through `account/rateLimits/read` (ADR 024). Each
// metered limit has up to two rolling windows; Codex says how long each one is, how much of it is
// used and when it refills, but not which one to show or how severe it is.

/** The limit every Codex model draws from; any other limit is scoped to the models it names. */
const MAIN_LIMIT = "codex";

const WEEK_MINUTES = 7 * 24 * 60;
const DAY_MINUTES = 24 * 60;

const isMain = (snapshot: RateLimitSnapshot) => snapshot.limitId === null || snapshot.limitId === MAIN_LIMIT;

/** The limits Codex reported, the main one first: every limit when it lists them, else its single view. */
const limitsOf = (response: GetAccountRateLimitsResponse): ReadonlyArray<RateLimitSnapshot> => {
  const listed = Object.values(response.rateLimitsByLimitId ?? {}).filter(
    (snapshot): snapshot is RateLimitSnapshot => snapshot !== undefined,
  );
  const limits = listed.length > 0 ? listed : [response.rateLimits];
  return [...limits.filter(isMain), ...limits.filter((snapshot) => !isMain(snapshot))];
};

/** A window's kind and group in the words the Usage screen names Claude Code's meters with. */
const windowKind = (minutes: number | null, main: boolean, slot: string) => {
  if (minutes === WEEK_MINUTES) return { kind: main ? "weekly_all" : "weekly_scoped", group: "weekly" };
  if (main && minutes !== null && minutes < DAY_MINUTES) return { kind: "session", group: "session" };
  return { kind: "window", group: minutes === null ? slot : `${Math.round(minutes / 60)} hours` };
};

const meterOf = (snapshot: RateLimitSnapshot, window: RateLimitWindow, slot: string): PlanMeter => {
  const main = isMain(snapshot);
  return {
    ...windowKind(window.windowDurationMins, main, slot),
    percent: window.usedPercent,
    resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt * 1000).toISOString(),
    scope: main ? null : (snapshot.limitName ?? snapshot.limitId),
    // Codex grades no window; a limit it says was reached is the only reading it gives.
    severity: snapshot.rateLimitReachedType === null ? "normal" : "critical",
    active: false,
  };
};

/**
 * A plan's meters from Codex's rate limits. Codex reports no spend in the plan's currency, so there
 * is no extra usage; an account without limits, such as an API key, reports no meter.
 */
export const planFromRateLimits = (response: GetAccountRateLimitsResponse, checkedAt: string): PlanUsage => {
  const meters = limitsOf(response).flatMap((snapshot) =>
    [
      snapshot.primary === null ? null : meterOf(snapshot, snapshot.primary, "primary"),
      snapshot.secondary === null ? null : meterOf(snapshot, snapshot.secondary, "secondary"),
    ].filter((meter): meter is PlanMeter => meter !== null),
  );
  return meters.length === 0
    ? unreportedPlan("codex", checkedAt)
    : { runtime: "codex", reported: true, meters, extraUsage: null, checkedAt };
};

/** Reads the plan's limits, which sends no prompt and so costs no usage. */
export const readRateLimits = (server: AppServer) =>
  server.request("account/rateLimits/read", { excludeResetCreditDetails: true });
