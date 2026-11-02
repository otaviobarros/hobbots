import { DeviceRepository } from "@hobbots/agents";
import { DeviceRevoked } from "@hobbots/api";
import {
  Device,
  type DeviceId,
  PairingRequest,
  type TailscaleIdentity,
  TailscaleOwner,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { oldestFirst } from "./order.ts";

// Oldest approval first, byte by byte on both dialects like `oldestFirst`.
const byApproval = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () => sql.literal(`approved_at COLLATE "C", id COLLATE "C"`),
    orElse: () => sql.literal("approved_at, id"),
  });

interface TailscaleColumns {
  readonly tailscaleNodeId?: unknown;
  readonly tailscaleNodeName?: unknown;
  readonly tailscaleOwner?: unknown;
}

const decodeOwner = Schema.decodeUnknownSync(Schema.fromJsonString(TailscaleOwner));
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(TailscaleOwner));

// The Tailscale node is three columns, its owner JSON text (migration 0029); a local device has none.
const tailscaleOf = <Row extends TailscaleColumns>(row: Row) => {
  const { tailscaleNodeId, tailscaleNodeName, tailscaleOwner, ...rest } = row;
  return {
    ...rest,
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
  "id, name, kind, platform, tailscale_node_id, tailscale_node_name, tailscale_owner, approved_at, last_active_at, revoked_at";

/** The SQL store of devices and pairing requests, for SQLite and PostgreSQL (ADR 011, ADR 021). */
export const DeviceRepositoryLive = Layer.effect(
  DeviceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
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

    const allowPairing = (id: string, device: Device, now: string) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO devices ${sql.insert({
          id: device.id,
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
        // Decided or expired meanwhile: the device is never created.
        if (updated.length === 0) return yield* Effect.fail("unchanged" as const);
        return yield* findPairing(id).pipe(Effect.orDie);
      }).pipe(
        sql.withTransaction,
        Effect.catchIf(
          (error) => error === "unchanged",
          () => Effect.succeed(Option.none()),
        ),
        Effect.orDie,
      );

    const denyPairing = (id: string, now: string) =>
      sql`UPDATE pairing_requests SET state = 'denied', decided_at = ${now}
        WHERE id = ${id} AND state = 'pending' AND expires_at > ${now} RETURNING id`.pipe(
        Effect.flatMap((updated) => (updated.length === 0 ? Effect.succeed(Option.none()) : findPairing(id))),
        Effect.orDie,
      );

    // Within the request's lifetime only, checked in the same statement that claims it.
    const claimPairing = (id: string, tokenHash: string, now: string) =>
      Effect.gen(function* () {
        const claimed = yield* sql<{ deviceId: string }>`UPDATE pairing_requests SET state = 'claimed'
          WHERE id = ${id} AND state = 'allowed' AND expires_at > ${now} RETURNING device_id`;
        const deviceId = claimed[0]?.deviceId;
        if (deviceId === undefined) return Option.none<PairingRequest>();
        yield* sql`UPDATE devices SET token_hash = ${tokenHash} WHERE id = ${deviceId}`;
        return yield* findPairing(id);
      }).pipe(sql.withTransaction, Effect.orDie);

    return DeviceRepository.of({
      findByTokenHash: (hash) => findByTokenHash(hash).pipe(Effect.orDie),
      find: (id) => find(id).pipe(Effect.orDie),
      list: list().pipe(Effect.orDie),
      ensureWindow: (at) =>
        sql`INSERT INTO devices ${sql.insert({
          id: WINDOW_DEVICE_ID,
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
      revoke: (id, at) =>
        sql`UPDATE devices SET revoked_at = ${at} WHERE id = ${id} AND revoked_at IS NULL RETURNING id`.pipe(
          Effect.flatMap((updated) => (updated.length === 0 ? Effect.succeed(Option.none()) : find(id))),
          Effect.orDie,
        ),
      whileApproved,
      openPairing: (request, secretHash) =>
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
        })}`.pipe(Effect.asVoid, Effect.orDie),
      findPairing: (id) => findPairing(id).pipe(Effect.orDie),
      findPairingBySecret: (hash) => findPairingBySecret(hash).pipe(Effect.orDie),
      listOpenPairing: (now) => listOpenPairing(now).pipe(Effect.orDie),
      allowPairing,
      denyPairing,
      claimPairing,
    });
  }),
);

// The secret's hash stays in the table: a pairing request read back never carries it.
const pairings = (rows: ReadonlyArray<TailscaleColumns & { readonly secretHash?: unknown }>) =>
  rows.map(({ secretHash: _, ...row }) => tailscaleOf(row));
