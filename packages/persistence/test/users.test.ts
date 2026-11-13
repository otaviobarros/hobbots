import { UserRepository, userOfActor } from "@hobbots/agents";
import { AgentId, HUB_ACTOR, hobActor, OWNER_ACTOR, OWNER_USER_ID, User, UserId, UserState } from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { migrations, UserRepositoryLive } from "../src/index.ts";
import users, { USER_STATES } from "../src/migrations/0111_users.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1451 (ADR 039, Users as actors): the owner is the user `owner`, so every `OWNER_ACTOR` a
// record stored before keeps naming a person. On SQLite and PostgreSQL alike (STD-TEST-006).

const owner = new User({ id: OWNER_USER_ID, name: "Owner", initials: "O", color: "amber", state: "active" });

/** The migrations that ran before 0111, when the hub had no users. */
const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0111")) as typeof migrations;

const run = <A, E>(
  effect: Effect.Effect<A, E, UserRepository | SqlClient.SqlClient>,
  database: typeof TestDatabase = TestDatabase,
) => effect.pipe(Effect.provide(UserRepositoryLive.pipe(Layer.provideMerge(database))), Effect.runPromise);

const storedUser = (row: { readonly id: string; readonly state: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO users ${sql.insert({ name: "Bruna Lima", initials: "BL", color: "sky", ...row })}`;
  });

describe("users", () => {
  // covers ADR 039 (Users as actors)
  it("[TC-PE-1451-01] makes the owner a user in one pass over a hub that had none, so OWNER_ACTOR resolves to it", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* users;
        return { resolved: yield* userOfActor(OWNER_ACTOR), list: yield* (yield* UserRepository).list };
      }),
      TestDatabaseAt(earlier),
    );
    expect(result.resolved).toEqual(Option.some(owner));
    expect(result.list).toEqual([owner]);
  });

  // covers ADR 039 (Users as actors)
  it("[TC-PE-1451-02] resolves only person actors with a user, and lists the owner first", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* storedUser({ id: "bruna", state: "active" });
        yield* storedUser({ id: "aaron", state: "active" });
        const repository = yield* UserRepository;
        return {
          ids: (yield* repository.list).map((user) => user.id),
          bruna: yield* repository.find(UserId.make("bruna")),
          unknown: yield* userOfActor({ kind: "user", id: "leo" }),
          hob: yield* userOfActor(hobActor(AgentId.make("owner"))),
          hub: yield* userOfActor(HUB_ACTOR),
        };
      }),
    );
    expect(result.ids).toEqual(["owner", "aaron", "bruna"]);
    expect(Option.map(result.bruna, (user) => user.name)).toEqual(Option.some("Bruna Lima"));
    expect(result.unknown).toEqual(Option.none());
    expect(result.hob).toEqual(Option.none());
    expect(result.hub).toEqual(Option.none());
  });

  // covers ADR 039 (Users as actors)
  it("[TC-PE-1451-03] refuses a user state outside the domain's, on insert and on update", async () => {
    // A new state needs a migration of its own.
    expect(USER_STATES).toEqual(UserState.literals);
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const inserted = yield* Effect.exit(storedUser({ id: "leo", state: "removed" }));
        const updated = yield* Effect.exit(sql`UPDATE users SET state = 'removed' WHERE id = 'owner'`);
        const states = yield* sql<{ readonly state: string }>`SELECT state FROM users`;
        return { inserted, updated, states };
      }),
    );
    expect(Exit.isFailure(result.inserted)).toBe(true);
    expect(Exit.isFailure(result.updated)).toBe(true);
    expect(result.states).toEqual([{ state: "active" }]);
  });
});
