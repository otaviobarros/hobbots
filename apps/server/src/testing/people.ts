import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceRepository, DeviceSecrets } from "@hobbots/agents";
import { TEST_PEOPLE_FILE, type TestPersonSeat, TestPersonSeats } from "@hobbots/api";
import {
  DEVICE_TOKEN_PREFIX,
  Device,
  DeviceId,
  PAIRING_LIFETIME_MS,
  PAIRING_SECRET_PREFIX,
  PairingRequest,
  User,
  UserId,
} from "@hobbots/domain";
import { addTestUser } from "@hobbots/persistence/testing";
import { Config, DateTime, Effect, Layer, Option, Schema } from "effect";
import { DeviceSecretsLive } from "../devices.ts";

/**
 * The people the browser tests play beside the owner (ADR 039): Bruna and Leo, each with a device
 * of their own. The hub has no way to add a person until accounts exist, so only this seam does.
 */
export const TEST_PEOPLE: ReadonlyArray<User> = [
  new User({ id: UserId.make("bruna"), name: "Bruna", initials: "B", color: "rose", state: "active" }),
  new User({ id: UserId.make("leo"), name: "Leo", initials: "L", color: "sky", state: "active" }),
];

/** The file in the data folder where the seam writes each person's device token, readable only by the user. */
export const testPeopleFile = (dataDir: string) => join(dataDir, TEST_PEOPLE_FILE);

const readSeats = (file: string): ReadonlyArray<TestPersonSeat> =>
  existsSync(file) ? Schema.decodeUnknownSync(TestPersonSeats)(readFileSync(file, "utf8")) : [];

/**
 * Gives `user` an approved browser device, as Allow would give it, with the token a browser keeps:
 * the device the seat names when it is still approved, or a new one.
 */
const seatFor = (user: User, held: Option.Option<TestPersonSeat>) =>
  Effect.gen(function* () {
    const repo = yield* DeviceRepository;
    const secrets = yield* DeviceSecrets;
    if (Option.isSome(held)) {
      const found = yield* repo.findByTokenHash(yield* secrets.hash(held.value.token));
      if (Option.isSome(found) && found.value.revokedAt === null && found.value.userId === user.id) return held.value;
    }
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(now);
    const deviceName = `${user.name}'s browser`;
    const request = new PairingRequest({
      id: crypto.randomUUID(),
      code: yield* secrets.code,
      name: deviceName,
      kind: "browser",
      platform: "test",
      tailscale: null,
      state: "pending",
      createdAt: at,
      expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: PAIRING_LIFETIME_MS })),
      decidedAt: null,
      deviceId: null,
    });
    yield* repo.openPairing(request, yield* secrets.hash(yield* secrets.generate(PAIRING_SECRET_PREFIX)));
    const device = new Device({
      id: DeviceId.make(crypto.randomUUID()),
      userId: user.id,
      name: deviceName,
      kind: "browser",
      platform: "test",
      tailscale: null,
      approvedAt: at,
      lastActiveAt: null,
      revokedAt: null,
    });
    yield* Effect.flatMap(repo.allowPairing(request.id, device, at), Effect.fromOption);
    const token = yield* secrets.generate(DEVICE_TOKEN_PREFIX);
    yield* Effect.flatMap(repo.claimPairing(request.id, yield* secrets.hash(token), at), Effect.fromOption);
    return { userId: user.id, name: user.name, deviceId: device.id, deviceName, token };
  }).pipe(Effect.orDie);

/**
 * With `HOBBOTS_TEST_PEOPLE=on`, adds Bruna and Leo and a device for each at start, and writes their
 * tokens to `test-people.json` (mode 0600). A restart on the same data folder keeps their devices.
 */
export const TestPeopleLive = (dataDir: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const file = testPeopleFile(dataDir);
      const held = readSeats(file);
      const seats: Array<TestPersonSeat> = [];
      for (const user of TEST_PEOPLE) {
        yield* addTestUser(user);
        seats.push(yield* seatFor(user, Option.fromNullishOr(held.find((seat) => seat.userId === user.id))));
      }
      const temporary = `${file}.${process.pid}`;
      yield* Effect.sync(() => {
        writeFileSync(temporary, Schema.encodeSync(TestPersonSeats)(seats), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, file);
      });
    }),
  ).pipe(Layer.provide(DeviceSecretsLive));

/**
 * The test seams of the browser tests' build of the hub, which replaces `../test-seams.ts` with this
 * module: Bruna and Leo when `HOBBOTS_TEST_PEOPLE` is `on`.
 */
export const testSeams = (dataDir: string) =>
  Layer.unwrap(
    Effect.map(
      Config.Literals(["off", "on"], "HOBBOTS_TEST_PEOPLE").pipe(Config.withDefault("off" as const)),
      (people) => (people === "on" ? TestPeopleLive(dataDir) : Layer.empty),
    ),
  );
