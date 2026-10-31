import { z } from "astro/zod";

/** Longest address an SMTP path allows (RFC 5321). */
const MAX_EMAIL = 254;

export const joinInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(MAX_EMAIL)),
  wantsMorePlatforms: z.boolean().default(false),
  source: z.enum(["hero", "roll"]),
  /** Honeypot: a field people never see, so only bots fill it. */
  website: z.string().max(MAX_EMAIL).default(""),
  turnstileToken: z.string().max(2048),
});

export type JoinInput = z.output<typeof joinInput>;

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<unknown>;
}

/** The part of a D1 database the wait-list uses. */
export interface WaitlistDb {
  prepare(query: string): Statement;
}

/** The part of a Workers rate limiting binding the wait-list uses. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface JoinDeps {
  db: WaitlistDb;
  limiter: Limiter;
  verifyHuman: (token: string) => Promise<boolean>;
  /** The caller's IP address, used only as the rate limit key. */
  ip: string | undefined;
}

/** "joined" also covers a repeated email and a filled honeypot, so the answer never reveals who is on the list. */
export type JoinOutcome = "joined" | "limited" | "unverified";

const INSERT =
  "INSERT INTO waitlist (email, wants_more_platforms, source) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING";

export const joinWaitlist = async (input: JoinInput, deps: JoinDeps): Promise<JoinOutcome> => {
  if (input.website) return "joined";
  const { success } = await deps.limiter.limit({ key: deps.ip ?? "unknown" });
  if (!success) return "limited";
  if (!(await deps.verifyHuman(input.turnstileToken))) return "unverified";
  await deps.db
    .prepare(INSERT)
    .bind(input.email, input.wantsMorePlatforms ? 1 : 0, input.source)
    .run();
  return "joined";
};
