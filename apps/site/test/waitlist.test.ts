import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type JoinDeps, joinInput, joinWaitlist, type Limiter, type WaitlistDb } from "../src/waitlist/join.ts";
import { verifyTurnstile } from "../src/waitlist/turnstile.ts";

const MIGRATION = readFileSync(new URL("../migrations/0001_waitlist.sql", import.meta.url), "utf8");

/** A D1-shaped wrapper over in-memory SQLite, the engine D1 runs, with the real migration applied. */
const memoryDb = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATION);
  const db: WaitlistDb = {
    prepare: (query) => {
      const statement = (values: unknown[]) => ({
        bind: (...next: unknown[]) => statement(next),
        run: async () => sqlite.prepare(query).run(...(values as never[])),
      });
      return statement([]);
    },
  };
  const rows = () => sqlite.prepare("SELECT email, wants_more_platforms, source FROM waitlist").all();
  return { db, rows };
};

/** The Workers rate limiter's rule: at most `limit` tries for each key. */
const countingLimiter = (limit: number): Limiter => {
  const tries = new Map<string, number>();
  return {
    limit: async ({ key }) => {
      tries.set(key, (tries.get(key) ?? 0) + 1);
      return { success: (tries.get(key) ?? 0) <= limit };
    },
  };
};

const setup = (overrides: Partial<JoinDeps> = {}) => {
  const { db, rows } = memoryDb();
  const deps: JoinDeps = {
    db,
    limiter: countingLimiter(5),
    verifyHuman: async (token) => token === "good",
    ip: "203.0.113.7",
    ...overrides,
  };
  return { deps, rows };
};

const input = (fields: Record<string, unknown> = {}) =>
  joinInput.parse({ email: "pip@example.com", source: "hero", turnstileToken: "good", ...fields });

describe("joinInput", () => {
  it("trims and lowercases the email", () => {
    expect(input({ email: "  Pip@Example.COM " }).email).toBe("pip@example.com");
  });

  it("refuses an invalid email", () => {
    for (const email of ["", "pip", "pip@", "pip@example", "pip @example.com"])
      expect(joinInput.safeParse({ email, source: "hero", turnstileToken: "good" }).success).toBe(false);
  });

  it("refuses an email over 254 characters", () => {
    const email = `${"a".repeat(64)}@${"b".repeat(185)}.com`;
    expect(email).toHaveLength(254);
    expect(joinInput.safeParse({ email, source: "hero", turnstileToken: "good" }).success).toBe(true);
    expect(joinInput.safeParse({ email: `a${email}`, source: "hero", turnstileToken: "good" }).success).toBe(false);
  });
});

describe("joinWaitlist", () => {
  it("stores a valid sign-up once", async () => {
    const { deps, rows } = setup();
    expect(await joinWaitlist(input({ wantsMorePlatforms: true }), deps)).toBe("joined");
    expect(rows()).toEqual([{ email: "pip@example.com", wants_more_platforms: 1, source: "hero" }]);
  });

  it("answers a repeated email the same way and stores nothing new", async () => {
    const { deps, rows } = setup();
    await joinWaitlist(input(), deps);
    expect(await joinWaitlist(input({ email: "PIP@example.com", source: "roll" }), deps)).toBe("joined");
    expect(rows()).toEqual([{ email: "pip@example.com", wants_more_platforms: 0, source: "hero" }]);
  });

  it("answers a filled honeypot as joined and stores nothing", async () => {
    const { deps, rows } = setup();
    expect(await joinWaitlist(input({ website: "https://spam.example" }), deps)).toBe("joined");
    expect(rows()).toEqual([]);
  });

  it("refuses a failed Turnstile check and stores nothing", async () => {
    const { deps, rows } = setup();
    expect(await joinWaitlist(input({ turnstileToken: "bad" }), deps)).toBe("unverified");
    expect(rows()).toEqual([]);
  });

  it("refuses the sixth try in a minute from one IP address", async () => {
    const { deps, rows } = setup();
    for (let i = 0; i < 5; i++)
      expect(await joinWaitlist(input({ email: `pip${i}@example.com` }), deps)).toBe("joined");
    expect(await joinWaitlist(input({ email: "pip5@example.com" }), deps)).toBe("limited");
    expect(await joinWaitlist(input({ email: "pip6@example.com" }), { ...deps, ip: "198.51.100.1" })).toBe("joined");
    expect(rows()).toHaveLength(6);
  });
});

describe("verifyTurnstile", () => {
  const answering =
    (body: unknown, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it("passes when Cloudflare says the token is valid", async () => {
    let sent: FormData | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      sent = init?.body as FormData;
      return new Response(JSON.stringify({ success: true }));
    };
    expect(await verifyTurnstile(fetcher, "secret", "token", "203.0.113.7")).toBe(true);
    expect(sent?.get("secret")).toBe("secret");
    expect(sent?.get("response")).toBe("token");
  });

  it("fails closed", async () => {
    expect(await verifyTurnstile(answering({ success: false }), "secret", "token", undefined)).toBe(false);
    expect(await verifyTurnstile(answering({ success: true }, 500), "secret", "token", undefined)).toBe(false);
    expect(await verifyTurnstile(answering({ success: true }), undefined, "token", undefined)).toBe(false);
    expect(await verifyTurnstile(answering({ success: true }), "secret", "", undefined)).toBe(false);
    const offline: typeof fetch = async () => {
      throw new TypeError("offline");
    };
    expect(await verifyTurnstile(offline, "secret", "token", undefined)).toBe(false);
  });
});
