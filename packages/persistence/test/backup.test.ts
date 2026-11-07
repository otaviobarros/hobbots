import { DeviceRepository } from "@hobbots/agents";
import { AgentId, Device, DeviceId, PairingRequest, SkillName, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
  applyRestoreRules,
  DeviceRepositoryLive,
  knownSchemaVersion,
  migrations,
  RestoreRepository,
  schemaVersion,
  scrubBackupCopy,
} from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = Layer.mergeAll(DeviceRepositoryLive, RestoreRepository.layer).pipe(Layer.provideMerge(TestDatabase));
const run = <A, E>(effect: Effect.Effect<A, E, DeviceRepository | RestoreRepository | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const NOW = "2026-11-03T10:00:00.000Z";
const RESTORED = "2026-11-03T12:00:00.000Z";

const asking = (id: string) =>
  new PairingRequest({
    id,
    code: "482913",
    name: "Safari on iPhone",
    kind: "browser",
    platform: "iOS",
    tailscale: null,
    state: "pending",
    createdAt: NOW,
    expiresAt: "2026-11-03T10:10:00.000Z",
    decidedAt: null,
    deviceId: null,
  });

const phone = (id: string) =>
  new Device({
    id: DeviceId.make(id),
    name: "Safari on iPhone",
    kind: "browser",
    platform: "iOS",
    tailscale: null,
    approvedAt: NOW,
    lastActiveAt: null,
    revokedAt: null,
  });

/** A hub with its window, a paired phone with a token, one phone you revoked, and a pairing request. */
const seedDevices = Effect.gen(function* () {
  const devices = yield* DeviceRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* devices.ensureWindow(NOW);
  yield* devices.openPairing(asking("pr_waiting"), "secret-hash-waiting");
  yield* devices.openPairing(asking("pr_paired"), "secret-hash-paired");
  yield* devices.allowPairing("pr_paired", phone("dev_phone"), NOW);
  yield* devices.claimPairing("pr_paired", "token-hash-phone", NOW);
  yield* devices.openPairing(asking("pr_old"), "secret-hash-old");
  yield* devices.allowPairing("pr_old", phone("dev_old"), NOW);
  yield* devices.claimPairing("pr_old", "token-hash-old", NOW);
  yield* devices.revoke(DeviceId.make("dev_old"), WINDOW_DEVICE_ID, NOW);
  yield* sql`UPDATE devices SET token_hash = 'token-hash-window' WHERE id = ${WINDOW_DEVICE_ID}`;
});

const secrets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* sql<{ tokenHash: string | null }>`SELECT token_hash FROM devices`;
  const requests = yield* sql<{ id: string }>`SELECT id FROM pairing_requests`;
  return { tokens: tokens.map((row) => row.tokenHash), requests: requests.length };
});

const restore = (id: string) => ({
  id,
  restoredAt: RESTORED,
  backupMadeAt: NOW,
  backupVersion: "0.15.0",
  setAside: "/data/hobbots.before-restore-20261103T120000",
  missingFolders: ["/Users/me/code/site"],
});

describe("backup and restore in the database", () => {
  // covers OP-003
  it("[TC-OP-017] takes every device token and pairing secret out of a backup's copy", async () => {
    const { before, after } = await run(
      Effect.gen(function* () {
        yield* seedDevices;
        const before = yield* secrets;
        yield* scrubBackupCopy;
        return { before, after: yield* secrets };
      }),
    );
    expect(before.tokens.filter((token) => token !== null).length).toBeGreaterThan(0);
    expect(before.requests).toBe(3);
    expect(after).toEqual({ tokens: [null, null, null], requests: 0 });
  });

  // covers OP-003
  it("[TC-OP-018] starts a restored hub on a new epoch with every device but the window revoked, only once", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seedDevices;
        const sql = yield* SqlClient.SqlClient;
        const epoch = sql<{ epoch: string }>`SELECT epoch FROM event_journal_head`.pipe(
          Effect.map((rows) => rows[0]?.epoch),
        );
        const before = yield* epoch;
        const first = yield* applyRestoreRules(restore("rs_1"));
        const between = yield* epoch;
        const second = yield* applyRestoreRules(restore("rs_1"));
        return {
          first,
          second,
          epochChanged: before !== between,
          epochKept: between === (yield* epoch),
          devices: yield* (yield* DeviceRepository).list,
          secrets: yield* secrets,
        };
      }),
    );
    expect(result).toMatchObject({ first: true, second: false, epochChanged: true, epochKept: true });
    const byId = new Map(result.devices.map((device) => [device.id, device]));
    expect(byId.get(WINDOW_DEVICE_ID)).toMatchObject({ revokedAt: null });
    expect(byId.get(WINDOW_DEVICE_ID)?.revokedReason).toBeUndefined();
    expect(byId.get(DeviceId.make("dev_phone"))).toMatchObject({ revokedAt: RESTORED, revokedReason: "restore" });
    expect(byId.get(DeviceId.make("dev_old"))).toMatchObject({ revokedAt: NOW });
    expect(byId.get(DeviceId.make("dev_old"))?.revokedReason).toBeUndefined();
    expect(result.secrets).toEqual({ tokens: [null, null, null], requests: 0 });
  });

  // covers OP-003
  it("[TC-OP-019] holds work until you resume it, and forgets the folder set aside once it is deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const restores = yield* RestoreRepository;
        const none = yield* restores.latest;
        yield* applyRestoreRules(restore("rs_1"));
        const held = yield* restores.latest;
        const resumed = yield* restores.resume("2026-11-03T13:00:00.000Z");
        const again = yield* restores.resume("2026-11-03T14:00:00.000Z");
        yield* restores.clearSetAside;
        return { none, held, resumed, again, cleared: yield* restores.latest };
      }),
    );
    expect(Option.isNone(result.none)).toBe(true);
    expect(Option.getOrThrow(result.held)).toMatchObject({
      id: "rs_1",
      restoredAt: RESTORED,
      backupMadeAt: NOW,
      backupVersion: "0.15.0",
      setAside: "/data/hobbots.before-restore-20261103T120000",
      missingFolders: ["/Users/me/code/site"],
      resumedAt: null,
    });
    expect(Option.getOrThrow(result.resumed).resumedAt).toBe("2026-11-03T13:00:00.000Z");
    expect(Option.getOrThrow(result.again).resumedAt).toBe("2026-11-03T13:00:00.000Z");
    expect(Option.getOrThrow(result.cleared)).toMatchObject({ setAside: null, resumedAt: "2026-11-03T13:00:00.000Z" });
  });

  // covers ADR 029 (Backups, exports and Diagnostics), #1139
  it("[TC-OP-124] notes on the latest restore what reading ~/.agents/skills again moved, and nothing without one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const restores = yield* RestoreRepository;
        const move = {
          skill: SkillName.make("release"),
          scope: { _tag: "Hob", agentId: AgentId.make("pip") },
        } as const;
        yield* restores.noteSkillMoves([move]);
        const none = yield* restores.latest;
        yield* applyRestoreRules(restore("rs_1"));
        const fresh = Option.getOrThrow(yield* restores.latest).skillMoves;
        yield* restores.noteSkillMoves([move]);
        yield* restores.noteSkillMoves([{ skill: SkillName.make("pdf-forms"), scope: { _tag: "Everyone" } }]);
        return { none, fresh, noted: Option.getOrThrow(yield* restores.latest).skillMoves };
      }),
    );
    expect(Option.isNone(result.none)).toBe(true);
    expect(result.fresh).toEqual([]);
    expect(result.noted).toEqual([
      { skill: "release", scope: { _tag: "Hob", agentId: "pip" } },
      { skill: "pdf-forms", scope: { _tag: "Everyone" } },
    ]);
  });

  // covers OP-003
  it("[TC-OP-020] knows the schema version it applied and the highest one it can open", async () => {
    const applied = await run(schemaVersion);
    expect(knownSchemaVersion()).toBe(74);
    expect(applied).toBe(knownSchemaVersion(migrations));
    expect(knownSchemaVersion({ "0002_two": 0, "0011_eleven": 0 })).toBe(11);
    expect(knownSchemaVersion({})).toBe(0);
  });
});
