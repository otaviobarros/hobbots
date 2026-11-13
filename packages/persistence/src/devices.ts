import { DeviceRepository } from "@hobbots/agents";
import { DeviceRevoked } from "@hobbots/api";
import {
  Device,
  type DeviceId,
  OWNER_USER_ID,
  PairingRequest,
  type TailscaleIdentity,
  TailscaleOwner,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { oldestFirst } from "./order.ts";

// Oldest approval first, byte by byte on both dialects like `oldestFirst`.
const byApproval = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () => sql.literal(`approved_at COLLATE "C", id COLLATE "C"`),
    orElse: () => sql.literal("approved_at, id"),
  });

interface TailscaleColumns {
  readonly revokedReason?: unknown;
  readonly tailscaleNodeId?: unknown;
  readonly tailscaleNodeName?: unknown;
  readonly tailscaleOwner?: unknown;
}

const decodeOwner = Schema.decodeUnknownSync(Schema.fromJsonString(TailscaleOwner));
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(TailscaleOwner));

// The Tailscale node is three columns, its owner JSON text (migration 0029); a local device has none.
// A revoke reason is kept only when there is one (migration 0038).
const tailscaleOf = <Row extends TailscaleColumns>(row: Row) => {
  const { tailscaleNodeId, tailscaleNodeName, tailscaleOwner, revokedReason, ...rest } = row;
  return {
    ...rest,
    ...(revokedReason === null || revokedReason === undefined ? {} : { revokedReason }),
    tailscale:
      tailscaleNodeId === null || tailscaleNodeId === undefined
        ? null
        : { nodeId: tailscaleNodeId, nodeName: tailscaleNodeName, owner: decodeOwner(tailscaleOwner) },
  };
};

const tailscaleColumns = (tailscale: TailscaleIdentity | null) => ({
  tailscale_node_id: tailscale?.nodeId ?? null,
  tailscale_node_name: tailscale?.nodeName ?? null,
  tailscale_owner: tailscale === null ? null : encodeOwner(tailscale.owner),
});

const DEVICE_COLUMNS =
  "id, user_id, name, kind, platform, tailscale_node_id, tailscale_node_name, tailscale_owner, approved_at, last_active_at, revoked_at, revoked_reason";

/** The SQL store of devices and pairing requests, for SQLite and PostgreSQL (ADR 011, ADR 021). */
export const DeviceRepositoryLive = Layer.effect(
  DeviceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const columns = sql.literal(DEVICE_COLUMNS);
    const devices = (rows: ReadonlyArray<TailscaleColumns>) => rows.map(tailscaleOf);

    const findByTokenHash = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Device,
      execute: (hash) => sql`SELECT ${columns} FROM devices WHERE token_hash = ${hash}`.pipe(Effect.map(devices)),
    });
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Device,
      execute: (id) => sql`SELECT ${columns} FROM devices WHERE id = ${id}`.pipe(Effect.map(devices)),
    });
    const list = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Device,
      execute: () =>
        sql`SELECT ${columns} FROM devices
          ORDER BY CASE WHEN id = ${WINDOW_DEVICE_ID} THEN 0 ELSE 1 END, ${byApproval(sql)}`.pipe(Effect.map(devices)),
    });
    const findPairing = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: PairingRequest,
      execute: (id) => sql`SELECT * FROM pairing_requests WHERE id = ${id}`.pipe(Effect.map(pairings)),
    });
    const findPairingBySecret = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: PairingRequest,
      execute: (hash) => sql`SELECT * FROM pairing_requests WHERE secret_hash = ${hash}`.pipe(Effect.map(pairings)),
    });
    const listOpenPairing = SqlSchema.findAll({
      Request: Schema.String,
      Result: PairingRequest,
      execute: (now) =>
        sql`SELECT * FROM pairing_requests WHERE state = 'pending' AND expires_at > ${now}
          ORDER BY ${oldestFirst(sql)}`.pipe(Effect.map(pairings)),
    });

    // On PostgreSQL the row is locked until the write commits, so a Revoke waits for it; SQLite's
    // one connection already runs the hub's writes one at a time.
    const lockApproved = (id: DeviceId) =>
      sql.onDialectOrElse({
        pg: () => sql`SELECT id FROM devices WHERE id = ${id} AND revoked_at IS NULL FOR UPDATE`,
        orElse: () => sql`SELECT id FROM devices WHERE id = ${id} AND revoked_at IS NULL`,
      });

    // Several rows at once, in byte order on both dialects, so two transactions never wait on each other.
    const lockDevices = (ids: ReadonlyArray<DeviceId>) =>
      sql.onDialectOrElse({
        pg: () => sql<{ readonly id: string; readonly revokedAt: string | null }>`SELECT id, revoked_at FROM devices
          WHERE ${sql.in("id", ids)} ORDER BY id COLLATE "C" FOR UPDATE`,
        orElse: () =>
          sql<{ readonly id: string; readonly revokedAt: string | null }>`SELECT id, revoked_at FROM devices
            WHERE ${sql.in("id", ids)}`,
      });

    const whileApproved =
      (id: DeviceId) =>
      <A, E, R>(write: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const approved = yield* lockApproved(id).pipe(Effect.orDie);
          if (approved.length === 0) {
            return yield* new DeviceRevoked({ message: "This device was removed from this hub." });
          }
          return yield* write;
        }).pipe(sql.withTransaction, Effect.catchTag("SqlError", Effect.die)) as Effect.Effect<A, E | DeviceRevoked, R>;

    // A pairing change journals the request as it now stands (ADR 021): the code and the device's
    // details, never a secret. None when the conditional update found nothing to change.
    const changed = (id: string, updated: ReadonlyArray<unknown>) =>
      updated.length === 0
        ? Effect.succeed(null)
        : findPairing(id).pipe(
            Effect.orDie,
            Effect.map(Option.getOrThrow),
            Effect.map((request) => ({ value: request, events: [{ _tag: "PairingChanged", request } as const] })),
          );

    // The device is created in the same transaction; a request decided or expired meanwhile changes
    // nothing, and the device's row rolls back with it.
    const allowPairing = (id: string, device: Device, now: string) =>
      journaled(1, () =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO devices ${sql.insert({
            id: device.id,
            user_id: device.userId,
            name: device.name,
            kind: device.kind,
            platform: device.platform,
            ...tailscaleColumns(device.tailscale),
            token_hash: null,
            approved_at: device.approvedAt,
            last_active_at: null,
            revoked_at: null,
          })}`;
          const updated = yield* sql`UPDATE pairing_requests
            SET state = 'allowed', decided_at = ${now}, device_id = ${device.id}
            WHERE id = ${id} AND state = 'pending' AND expires_at > ${now} RETURNING id`;
          return yield* changed(id, updated);
        }),
      );

    const denyPairing = (id: string, now: string) =>
      journaled(1, () =>
        sql`UPDATE pairing_requests SET state = 'denied', decided_at = ${now}
          WHERE id = ${id} AND state = 'pending' AND expires_at > ${now} RETURNING id`.pipe(
          Effect.flatMap((updated) => changed(id, updated)),
        ),
      );

    // Only a request still open, and only ever later: a second Decide later changes nothing.
    const deferPairing = (id: string, expiresAt: string, now: string) =>
      journaled(1, () =>
        sql`UPDATE pairing_requests SET expires_at = ${expiresAt}
          WHERE id = ${id} AND state = 'pending' AND expires_at > ${now} AND expires_at < ${expiresAt}
          RETURNING id`.pipe(Effect.flatMap((updated) => changed(id, updated))),
      );

    // Within the request's lifetime only, checked in the same statement that claims it.
    const claimPairing = (id: string, tokenHash: string, now: string) =>
      journaled(1, () =>
        Effect.gen(function* () {
          const claimed = yield* sql<{ deviceId: string }>`UPDATE pairing_requests SET state = 'claimed'
            WHERE id = ${id} AND state = 'allowed' AND expires_at > ${now} RETURNING device_id`;
          const deviceId = claimed[0]?.deviceId;
          if (deviceId === undefined) return null;
          yield* sql`UPDATE devices SET token_hash = ${tokenHash} WHERE id = ${deviceId}`;
          return yield* changed(id, claimed);
        }),
      );

    return DeviceRepository.of({
      findByTokenHash: (hash) => findByTokenHash(hash).pipe(Effect.orDie),
      find: (id) => find(id).pipe(Effect.orDie),
      list: list().pipe(Effect.orDie),
      ensureWindow: (at) =>
        sql`INSERT INTO devices ${sql.insert({
          id: WINDOW_DEVICE_ID,
          // The hub's window is the owner's: whoever runs the hub on this computer (ADR 039).
          user_id: OWNER_USER_ID,
          name: "This computer's Hobbots window",
          kind: "window",
          platform: "",
          ...tailscaleColumns(null),
          token_hash: null,
          approved_at: at,
          last_active_at: null,
          revoked_at: null,
        })} ON CONFLICT (id) DO NOTHING`.pipe(Effect.asVoid, Effect.orDie),
      touch: (id, at) =>
        sql`UPDATE devices SET last_active_at = ${at} WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
      // The hub's window is never revoked: its key changes on every start instead.
      revoke: (id, by, at) =>
        Effect.gen(function* () {
          // Both rows before the journal head, in one order, as a guarded decision takes its own row
          // before journaling: a decision the target already started finishes first, and none deadlocks.
          const locked = yield* lockDevices([id, by]).pipe(Effect.orDie);
          if (!locked.some((row) => row.id === by && row.revokedAt === null)) {
            return yield* new DeviceRevoked({ message: "This device was removed from this hub." });
          }
          return yield* journaled(1, () =>
            Effect.gen(function* () {
              const updated = yield* sql`UPDATE devices SET revoked_at = ${at}
                WHERE id = ${id} AND id <> ${WINDOW_DEVICE_ID} AND revoked_at IS NULL RETURNING id`;
              if (updated.length === 0) return null;
              const device = yield* find(id).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
              return { value: device, events: [{ _tag: "DeviceRevoked", device } as const] };
            }),
          );
        }).pipe(sql.withTransaction, Effect.catchTag("SqlError", Effect.die)),
      whileApproved,
      openPairing: (request, secretHash) =>
        journaled(1, () =>
          sql`INSERT INTO pairing_requests ${sql.insert({
            id: request.id,
            code: request.code,
            secret_hash: secretHash,
            name: request.name,
            kind: request.kind,
            platform: request.platform,
            ...tailscaleColumns(request.tailscale),
            state: request.state,
            created_at: request.createdAt,
            expires_at: request.expiresAt,
            decided_at: request.decidedAt,
            device_id: request.deviceId,
          })}`.pipe(Effect.as({ value: request, events: [{ _tag: "PairingRequested", request } as const] })),
        ).pipe(Effect.map(Option.getOrThrow)),
      findPairing: (id) => findPairing(id).pipe(Effect.orDie),
      findPairingBySecret: (hash) => findPairingBySecret(hash).pipe(Effect.orDie),
      listOpenPairing: (now) => listOpenPairing(now).pipe(Effect.orDie),
      allowPairing,
      denyPairing,
      deferPairing,
      claimPairing,
    });
  }),
);

// The secret's hash stays in the table: a pairing request read back never carries it.
const pairings = (rows: ReadonlyArray<TailscaleColumns & { readonly secretHash?: unknown }>) =>
  rows.map(({ secretHash: _, ...row }) => tailscaleOf(row));
