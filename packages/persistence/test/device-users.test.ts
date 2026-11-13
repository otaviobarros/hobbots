import { DeviceRepository, HobbotsRepository } from "@hobbots/agents";
import { DeviceId, Message, MessageId, OWNER_USER_ID, ThreadId, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { DeviceRepositoryLive, EventJournal, HobbotsRepositoryLive, migrations } from "../src/index.ts";
import deviceUsers from "../src/migrations/0112_device_users.ts";
import { TestDatabase, TestDatabaseAt } from "../src/testing.ts";

// Issue #1452 (ADR 039, Users as actors): every device belongs to a user, the owner until accounts
// exist, and a person's message names them as it is stored. On SQLite and PostgreSQL alike (STD-TEST-006).

const NOW = "2026-11-13T10:00:00.000Z";

/** The migrations that ran before 0112, when a device named no user. */
const earlier = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0112")) as typeof migrations;

type Services = DeviceRepository | HobbotsRepository | EventJournal | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>, database: typeof TestDatabase = TestDatabase) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(DeviceRepositoryLive, HobbotsRepositoryLive, EventJournal.layer).pipe(
        Layer.provideMerge(database),
      ),
    ),
    Effect.runPromise,
  );

/** A device row as a hub before 0112 stored it, with no user. */
const oldDevice = (id: string, revokedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO devices ${sql.insert({
      id,
      name: id,
      kind: id === WINDOW_DEVICE_ID ? "window" : "browser",
      platform: "",
      token_hash: null,
      approved_at: NOW,
      last_active_at: null,
      revoked_at: revokedAt,
    })}`;
  });

describe("devices and users", () => {
  // covers ADR 039 (Users as actors)
  it("[TC-PE-1452-01] gives every device a hub had, the window and a revoked one too, to the owner", async () => {
    const devices = await run(
      Effect.gen(function* () {
        yield* oldDevice(WINDOW_DEVICE_ID, null);
        yield* oldDevice("phone", null);
        yield* oldDevice("old-laptop", NOW);
        yield* deviceUsers;
        return yield* (yield* DeviceRepository).list;
      }),
      TestDatabaseAt(earlier),
    );
    expect(devices.map((device) => [device.id, device.userId])).toEqual([
      [WINDOW_DEVICE_ID, OWNER_USER_ID],
      ["old-laptop", OWNER_USER_ID],
      ["phone", OWNER_USER_ID],
    ]);
  });

  // covers ADR 039 (Users as actors), ADR 013 (The envelope)
  it("[TC-PE-1452-05] keeps a revocation journaled before the upgrade readable, with its device the owner's", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* oldDevice("old-laptop", NOW);
        // As the hub journaled a revocation before 0112: version 1, and a device with no user.
        const device = {
          id: "old-laptop",
          name: "old-laptop",
          kind: "browser",
          platform: "",
          tailscale: null,
          approvedAt: NOW,
          lastActiveAt: null,
          revokedAt: NOW,
        };
        yield* sql`INSERT INTO event_journal ${sql.insert({
          sequence: 1,
          id: "event-1",
          type: "DeviceRevoked",
          schema_version: 1,
          occurred_at: NOW,
          payload: JSON.stringify({ _tag: "DeviceRevoked", device }),
        })}`;
        yield* sql`UPDATE event_journal_head SET sequence = 1`;
        yield* deviceUsers;
        return yield* (yield* EventJournal).readAfter(0);
      }),
      TestDatabaseAt(earlier),
    );
    expect(entries.map((entry) => [entry.type, entry.schemaVersion])).toEqual([["DeviceRevoked", 2]]);
    expect(entries[0]?.payload).toMatchObject({
      _tag: "DeviceRevoked",
      device: { id: "old-laptop", userId: OWNER_USER_ID, revokedAt: NOW },
    });
  });

  // covers ADR 039 (Users as actors)
  it("[TC-PE-1452-02] keeps a new device's user, and refuses a device with none or with an unknown one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* DeviceRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.ensureWindow(NOW);
        yield* sql`INSERT INTO users ${sql.insert({ id: "bruna", name: "Bruna", initials: "B", color: "sky", state: "active" })}`;
        const row = (id: string, userId: string | null) =>
          Effect.exit(
            sql`INSERT INTO devices ${sql.insert({ id, user_id: userId, name: id, kind: "browser", platform: "", approved_at: NOW })}`,
          );
        const bruna = yield* row("brunas-phone", "bruna");
        const none = yield* row("nobodys-phone", null);
        const cleared = yield* Effect.exit(sql`UPDATE devices SET user_id = NULL WHERE id = 'brunas-phone'`);
        return {
          bruna,
          none,
          cleared,
          window: yield* repo.find(WINDOW_DEVICE_ID),
          phone: yield* repo.find(DeviceId.make("brunas-phone")),
        };
      }),
    );
    expect(Exit.isSuccess(result.bruna)).toBe(true);
    expect(Exit.isFailure(result.none)).toBe(true);
    expect(Exit.isFailure(result.cleared)).toBe(true);
    expect(Option.map(result.window, (device) => device.userId)).toEqual(Option.some(OWNER_USER_ID));
    expect(Option.map(result.phone, (device) => device.userId)).toEqual(Option.some("bruna"));
  });

  // covers ADR 039 (Users as actors), STD-ARCH-019
  it("[TC-PE-1452-03] stores a person's message only when it names its author, and never assumes the owner", async () => {
    const exit = await run(
      Effect.exit(
        Effect.gen(function* () {
          const repo = yield* HobbotsRepository;
          return yield* repo.upsertMessage(
            new Message({
              id: MessageId.make("m1"),
              threadId: ThreadId.make("t1"),
              role: "user",
              content: "hello",
              status: "complete",
              error: null,
              configVersion: null,
              createdAt: NOW,
            }),
          );
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("must name the person who wrote it");
  });
});
