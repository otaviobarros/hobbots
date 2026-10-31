import { ActionError, defineAction } from "astro:actions";
import { env } from "cloudflare:workers";
import { joinInput, joinWaitlist } from "../waitlist/join.ts";
import { verifyTurnstile } from "../waitlist/turnstile.ts";

// Never log the email or the IP address: the messages below name only what failed.
export const server = {
  waitlist: {
    join: defineAction({
      input: joinInput,
      handler: async (input, context) => {
        const ip = context.clientAddress;
        let outcome: Awaited<ReturnType<typeof joinWaitlist>>;
        try {
          outcome = await joinWaitlist(input, {
            db: env.WAITLIST_DB,
            limiter: env.SIGNUP_LIMIT,
            verifyHuman: (token) => verifyTurnstile(fetch, env.TURNSTILE_SECRET_KEY, token, ip),
            ip,
          });
        } catch {
          console.error("waitlist.join: saving the sign-up failed");
          throw new ActionError({ code: "INTERNAL_SERVER_ERROR", message: "The sign-up was not saved." });
        }
        if (outcome === "limited")
          throw new ActionError({ code: "TOO_MANY_REQUESTS", message: "Too many sign-ups from this address." });
        if (outcome === "unverified")
          throw new ActionError({ code: "FORBIDDEN", message: "The human check did not pass." });
        return { joined: true };
      },
    }),
  },
};
