import { HubCommitIdentities } from "@hobbots/agents";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { HubCommitIdentityRepository } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

// Issue #741: who hobs on the user's account commit as when the user's Git config sets no identity,
// as the user told the hub, on SQLite and PostgreSQL alike.

describe("The commit identity the user gave the hub", () => {
  // covers OR-004
  it("[TC-OR-601] is none until given, round-trips, and a new answer replaces the old one", async () => {
    const found = await Effect.gen(function* () {
      const identities = yield* HubCommitIdentities;
      const before = yield* identities.get;
      yield* identities.save({ name: "otaviobarros", email: "35647586+otaviobarros@users.noreply.github.com" }, "t1");
      const given = yield* identities.get;
      yield* identities.save({ name: "Otavio Barros", email: "otavio@example.com" }, "t2");
      return { before, given, replaced: yield* identities.get };
    }).pipe(Effect.provide(HubCommitIdentityRepository), Effect.provide(TestDatabase), Effect.runPromise);

    expect(found.before).toBeNull();
    expect(found.given).toEqual({ name: "otaviobarros", email: "35647586+otaviobarros@users.noreply.github.com" });
    expect(found.replaced).toEqual({ name: "Otavio Barros", email: "otavio@example.com" });
  });
});
