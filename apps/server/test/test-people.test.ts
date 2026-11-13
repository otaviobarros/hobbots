import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRepository, DeviceSecrets, UserRepository } from "@hobbots/agents";
import { OWNER_USER_ID } from "@hobbots/domain";
import { DeviceRepositoryLive, UserRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { type Config, ConfigProvider, Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceSecretsLive } from "../src/devices.ts";
import { type Seat, TEST_PEOPLE, TestPeopleLive, testPeopleFile, testSeams } from "../src/testing/people.ts";

// Issue #1457 (ADR 039, How we test several people): the browser tests' build of the hub adds Bruna
// and Leo with a device each, so a test plays two people on two devices. On SQLite and PostgreSQL
// alike (STD-TEST-006).

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hobbots-test-people-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const seats = (): ReadonlyArray<Seat> => JSON.parse(readFileSync(testPeopleFile(dataDir), "utf8"));

const stores = Layer.mergeAll(DeviceRepositoryLive, UserRepositoryLive, DeviceSecretsLive).pipe(
  Layer.provideMerge(TestDatabase),
);

/** Starts the seam `times` times on one database and data folder, as restarts of one hub would. */
const startTimes = (
  times: number,
  seam: Layer.Layer<never, Config.ConfigError, DeviceRepository | SqlClient.SqlClient> = TestPeopleLive(dataDir),
) =>
  Effect.gen(function* () {
    for (let start = 0; start < times; start++) yield* Layer.build(seam).pipe(Effect.scoped);
    const devices = yield* DeviceRepository;
    const secrets = yield* DeviceSecrets;
    const found = [];
    for (const seat of existsSync(testPeopleFile(dataDir)) ? seats() : [])
      found.push(yield* devices.findByTokenHash(yield* secrets.hash(seat.token)));
    return { users: yield* (yield* UserRepository).list, devices: yield* devices.list, found };
  }).pipe(Effect.provide(stores), Effect.runPromise);

describe("test people", () => {
  // covers ADR 039 (Users as actors)
  it("[TC-PE-1457-01] adds Bruna and Leo after the owner, each with an approved browser device whose token the file holds", async () => {
    const result = await startTimes(1);
    expect(result.users.map((user) => user.id)).toEqual([OWNER_USER_ID, "bruna", "leo"]);
    expect(seats().map((seat) => [seat.userId, seat.deviceName])).toEqual([
      ["bruna", "Bruna's browser"],
      ["leo", "Leo's browser"],
    ]);
    // Each token names its person's device, still approved, as Allow and the first status check leave it.
    expect(result.found.map(Option.map((device) => [device.userId, device.kind, device.revokedAt]))).toEqual([
      Option.some(["bruna", "browser", null]),
      Option.some(["leo", "browser", null]),
    ]);
    expect(statSync(testPeopleFile(dataDir)).mode & 0o777).toBe(0o600);
  });

  // covers ADR 039 (Users as actors)
  it("[TC-PE-1457-02] keeps the same people and devices when the hub starts again on the same data", async () => {
    const result = await startTimes(2);
    expect(result.users).toHaveLength(1 + TEST_PEOPLE.length);
    // The window is added by the device service, which this test does not start: only the two seats.
    expect(result.devices.map((device) => device.userId).sort()).toEqual(["bruna", "leo"]);
    expect(result.found.every(Option.isSome)).toBe(true);
  });

  // covers ADR 039 (Users as actors)
  it("[TC-PE-1457-03] adds no one unless HOBBOTS_TEST_PEOPLE is on", async () => {
    const withEnv = (env: Record<string, string>) =>
      testSeams(dataDir).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));
    const off = await startTimes(1, withEnv({}));
    expect(off.users.map((user) => user.id)).toEqual([OWNER_USER_ID]);
    expect(existsSync(testPeopleFile(dataDir))).toBe(false);
    const on = await startTimes(1, withEnv({ HOBBOTS_TEST_PEOPLE: "on" }));
    expect(on.users.map((user) => user.id)).toEqual([OWNER_USER_ID, "bruna", "leo"]);
  });
});
