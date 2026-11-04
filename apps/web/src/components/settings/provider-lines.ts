import type { RuntimeHealth, RuntimeKind } from "@hobbots/domain";
import { formatCount, plural } from "../../lib/format.ts";
import { billingOf } from "../../lib/usage.ts";
import { messages } from "./messages.ts";

const copy = messages.providers.lines;

/** The plan in a runtime's billing, such as `max` in "subscription (max)", or null when it names none. */
const planName = (billing: string): string | null => {
  const plan = /^subscription \((.+)\)$/.exec(billing)?.[1]?.trim();
  return plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : null;
};

/**
 * How a ready provider is signed in and on which plan, from what its health reports, or null when
 * it reports nothing. It never names the account: health detail can carry account names.
 */
export const accountLine = (health: RuntimeHealth | undefined): string | null => {
  if (health?.availability !== "ready" || health.billing === null || health.billing === "fake") return null;
  switch (billingOf(health.billing)) {
    case "subscription": {
      const plan = planName(health.billing);
      return plan === null ? copy.subscription : copy.plan({ plan });
    }
    case "apiKey":
      return copy.apiKey;
    case "unknown":
      return null;
  }
};

/** How many of your hobs think with a provider, out of all of them. */
export const hobsLine = (
  runtime: RuntimeKind,
  name: string,
  hobs: ReadonlyArray<{ readonly runtime: RuntimeKind }>,
): string => {
  const count = hobs.filter((hob) => hob.runtime === runtime).length;
  if (count === 0) return copy.noHobs({ name });
  if (count === hobs.length) {
    return plural(count, { one: copy.onlyHob({ name }), other: copy.allHobs({ count: formatCount(count), name }) });
  }
  return copy.someHobs({ count: formatCount(count), total: formatCount(hobs.length), name });
};
