import type { Grant } from "@hobbots/domain";
import { formatDay } from "../../lib/time.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** The "Always" rules among the grants that apply now, most recently saved first. */
export const standingRules = (grants: ReadonlyArray<Grant>): Array<Grant> =>
  grants.filter((grant) => grant.lifetime === "always").sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** When a rule was saved and last answered a call: "Saved Oct 26 · last used Oct 31". */
export const ruleMeta = (grant: Grant, now: Date = new Date()): string =>
  [
    copy.saved({ day: formatDay(grant.createdAt, now) }),
    grant.lastUsedAt === null ? copy.notUsed : copy.lastUsed({ day: formatDay(grant.lastUsedAt, now) }),
  ].join(" · ");
