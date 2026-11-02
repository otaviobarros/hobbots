import { DeviceRepository } from "@hobbots/agents";
import { Device, DeviceId, PairingRequest, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { DeviceRepositoryLive } from "../src/index.ts";
import { TestDatabase } from "../src/testing.ts";

const TestLayer = DeviceRepositoryLive.pipe(Layer.provideMerge(TestDatabase));
const run = <A, E>(effect: Effect.Effect<A, E, DeviceRepository | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(TestLayer), Effect.runPromise);

const NOW = "2026-11-02T10:00:00.000Z";
const LATER = "2026-11-02T10:05:00.000Z";
const EXPIRED = "2026-11-02T10:11:00.000Z";

const asking = (id: string, overrides: Partial<PairingRequest> = {}) =>
  new PairingRequest({
    id,
    code: "482913",
    name: "Safari on iPhone",
    kind: "browser",
    platform: "iOS",
    tailscale: { nodeId: "nPHONE", nodeName: "phone", owner: { _tag: "User", login: "otavio@example.com" } },
    state: "pending",
    createdAt: NOW,
    expiresAt: "2026-11-02T10:10:00.000Z",
    decidedAt: null,
    deviceId: null,
    ...overrides,
  });

const deviceFor = (request: PairingRequest, id: string) =>
  new Device({
    id: DeviceId.make(id),
    name: request.name,
    kind: request.kind,
    platform: request.platform,
    tailscale: request.tailscale,
    approvedAt: LATER,
    lastActiveAt: null,
    revokedAt: null,
  });

describe("DeviceRepository", () => {
  // covers DP-004
  it("[TC-DP-080] keeps one window device for the installation, however often the hub starts", async () => {
    const devices = await run(
      Effect.gen(function* () {
        const repo = yield* DeviceRepository;
        yield* repo.ensureWindow(NOW);
        yield* repo.ensureWindow(LATER);
        return yield* repo.list;
      }),
    );
    expect(devices).toMatchObject([{ id: WINDOW_DEVICE_ID, kind: "window", approvedAt: NOW, revokedAt: null }]);
  });

  // covers DP-004
  it("[TC-DP-081] allows a pending request once, creates its device and hands its token's hash over once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* DeviceRepository;
        const sql = yield* SqlClient.SqlClient;
        const request = asking("p1");
        yield* repo.openPairing(request, "secret-hash");
        const open = yield* repo.listOpenPairing(LATER);
        const allowed = yield* repo.allowPairing("p1", deviceFor(request, "d1"), LATER);
        const again = yield* repo.allowPairing("p1", deviceFor(request, "d2"), LATER);
        const claimed = yield* repo.claimPairing("p1", "token-hash", LATER);
        const reclaimed = yield* repo.claimPairing("p1", "other-hash", LATER);
        return {
          open,
          allowed,
          again,
          claimed,
          reclaimed,
          bySecret: yield* repo.findPairingBySecret("secret-hash"),
          byToken: yield* repo.findByTokenHash("token-hash"),
          byOther: yield* repo.findByTokenHash("other-hash"),
          deviceIds: (yield* sql<{ id: string }>`SELECT id FROM devices ORDER BY id`).map((row) => row.id),
        };
      }),
    );
    expect(result.open.map((request) => request.id)).toEqual(["p1"]);
    expect(Option.getOrThrow(result.allowed).value).toMatchObject({
      state: "allowed",
      decidedAt: LATER,
      deviceId: "d1",
    });
    expect(Option.isNone(result.again)).toBe(true);
    expect(Option.getOrThrow(result.claimed).value).toMatchObject({ state: "claimed", deviceId: "d1" });
    expect(Option.isNone(result.reclaimed)).toBe(true);
    expect(Option.getOrThrow(result.bySecret)).not.toHaveProperty("secretHash");
    expect(Option.getOrThrow(result.byToken)).toMatchObject({
      id: "d1",
      name: "Safari on iPhone",
      tailscale: { nodeId: "nPHONE", owner: { _tag: "User", login: "otavio@example.com" } },
    });
    expect(Option.isNone(result.byOther)).toBe(true);
    // A device that was never allowed is never created.
    expect(result.deviceIds).toEqual(["d1"]);
  });

  // covers DP-004
  it("[TC-DP-082] refuses to allow, deny or claim a request that expired or was decided", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* DeviceRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.openPairing(asking("late"), "late-hash");
        yield* repo.openPairing(asking("denied", { code: "100200" }), "denied-hash");
        // Allowed in time, but claimed only after the request expired: no token is ever set.
        yield* repo.openPairing(asking("unclaimed", { code: "300400" }), "unclaimed-hash");
        yield* repo.allowPairing("unclaimed", deviceFor(asking("unclaimed"), "du"), LATER);
        const lateClaim = yield* repo.claimPairing("unclaimed", "late-token-hash", EXPIRED);
        const unclaimed = yield* repo.findPairing("unclaimed");
        const tokens = yield* sql<{ tokenHash: string | null }>`SELECT token_hash FROM devices`;
        return {
          lateClaim,
          unclaimed,
          tokens,
          lateAllow: yield* repo.allowPairing("late", deviceFor(asking("late"), "dl"), EXPIRED),
          lateDeny: yield* repo.denyPairing("late", EXPIRED),
          denied: yield* repo.denyPairing("denied", LATER),
          allowAfterDeny: yield* repo.allowPairing("denied", deviceFor(asking("denied"), "dd"), LATER),
          open: yield* repo.listOpenPairing(EXPIRED),
        };
      }),
    );
    expect(Option.isNone(result.lateAllow)).toBe(true);
    expect(Option.isNone(result.lateDeny)).toBe(true);
    expect(Option.getOrThrow(result.denied).value).toMatchObject({ state: "denied", deviceId: null });
    expect(Option.isNone(result.allowAfterDeny)).toBe(true);
    expect(Option.isNone(result.lateClaim)).toBe(true);
    expect(Option.getOrThrow(result.unclaimed)).toMatchObject({ state: "allowed" });
    expect(result.tokens).toEqual([{ tokenHash: null }]);
    expect(result.open).toEqual([]);
  });

  // covers DP-004, PE-006
  it("[TC-DP-083] runs a write only while its device is approved, and a revoked device's write is rolled back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* DeviceRepository;
        const sql = yield* SqlClient.SqlClient;
        const request = asking("p1");
        yield* repo.openPairing(request, "secret-hash");
        yield* repo.allowPairing("p1", deviceFor(request, "d1"), LATER);
        const mark = (name: string) =>
          sql`INSERT INTO pairing_requests ${sql.insert({
            id: name,
            code: "000000",
            secret_hash: name,
            name,
            kind: "browser",
            platform: "",
            state: "denied",
            created_at: NOW,
            expires_at: NOW,
          })}`;
        const before = yield* Effect.exit(repo.whileApproved(DeviceId.make("d1"))(mark("while-approved")));
        const revoked = yield* repo.revoke(DeviceId.make("d1"), EXPIRED);
        const revokedAgain = yield* repo.revoke(DeviceId.make("d1"), EXPIRED);
        const after = yield* Effect.exit(repo.whileApproved(DeviceId.make("d1"))(mark("after-revoke")));
        const unknown = yield* Effect.exit(repo.whileApproved(DeviceId.make("nobody"))(mark("unknown")));
        const marks = yield* sql<{ id: string }>`SELECT id FROM pairing_requests WHERE id <> 'p1' ORDER BY id`;
        return { before, revoked, revokedAgain, after, unknown, marks: marks.map((row) => row.id) };
      }),
    );
    expect(Exit.isSuccess(result.before)).toBe(true);
    expect(Option.getOrThrow(result.revoked)).toMatchObject({ id: "d1", revokedAt: EXPIRED });
    expect(Option.isNone(result.revokedAgain)).toBe(true);
    expect(result.after).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(result.after)).toContain("DeviceRevoked");
    expect(JSON.stringify(result.unknown)).toContain("DeviceRevoked");
    expect(result.marks).toEqual(["while-approved"]);
  });

  // covers DP-004
  it("[TC-DP-090] journals every pairing change with the request's code and details, never its secret", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* DeviceRepository;
        const sql = yield* SqlClient.SqlClient;
        const opened = yield* repo.openPairing(asking("p1"), "secret-hash");
        const deferred = yield* repo.deferPairing("p1", "2026-11-03T10:00:00.000Z", LATER);
        // Deciding later again, or to an earlier time, changes nothing.
        const sooner = yield* repo.deferPairing("p1", "2026-11-02T12:00:00.000Z", LATER);
        const allowed = yield* repo.allowPairing("p1", deviceFor(asking("p1"), "d1"), EXPIRED);
        const claimed = yield* repo.claimPairing("p1", "token-hash", EXPIRED);
        const journal = yield* sql<{ type: string; payload: string }>`SELECT type, payload FROM event_journal
          ORDER BY sequence`;
        return { opened, deferred, sooner, allowed, claimed, journal };
      }),
    );
    expect(result.opened.entries.map((entry) => entry.type)).toEqual(["PairingRequested"]);
    expect(Option.getOrThrow(result.deferred).value).toMatchObject({ expiresAt: "2026-11-03T10:00:00.000Z" });
    expect(Option.isNone(result.sooner)).toBe(true);
    // A deferred request can still be allowed after its first ten minutes.
    expect(Option.getOrThrow(result.allowed).value).toMatchObject({ state: "allowed" });
    expect(Option.getOrThrow(result.claimed).value).toMatchObject({ state: "claimed" });
    expect(result.journal.map((row) => row.type)).toEqual([
      "PairingRequested",
      "PairingChanged",
      "PairingChanged",
      "PairingChanged",
    ]);
    const payloads = result.journal.map((row) => row.payload).join("\n");
    expect(payloads).toContain('"code":"482913"');
    expect(payloads).not.toContain("secret-hash");
    expect(payloads).not.toContain("token-hash");
  });
});
