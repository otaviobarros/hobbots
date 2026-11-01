import { GrantRepository } from "@hobbots/agents";
import { Grant, GrantId } from "@hobbots/domain";
import { Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { oldestFirst } from "./order.ts";

interface GrantRowShape {
  readonly rule?: unknown;
  readonly revision?: unknown;
}

// The rule is JSON text and the revision a bigint on PostgreSQL (migration 0022).
const grantRows = (rows: ReadonlyArray<GrantRowShape>) =>
  rows.map((row) => ({ ...row, rule: JSON.parse(String(row.rule)), revision: Number(row.revision) }));

/** A grant at its journal revision, and the columns it is stored with. */
export const grantRow = (input: Grant, revision: number) => {
  const grant = new Grant({ ...input, revision });
  return {
    grant,
    columns: {
      id: grant.id,
      agent_id: grant.agentId,
      operation: grant.operation,
      rule: JSON.stringify(grant.rule),
      lifetime: grant.lifetime,
      quest_id: grant.questId,
      approval_id: grant.approvalId,
      granted_by: grant.grantedBy,
      created_at: grant.createdAt,
      expires_at: grant.expiresAt,
      last_used_at: grant.lastUsedAt,
      revoked_at: grant.revokedAt,
      revoked_by: grant.revokedBy,
      revoke_reason: grant.revokeReason,
      revision,
    },
  };
};

/** The SQL store of standing grants, for SQLite and PostgreSQL (ADR 011, ADR 015). */
export const GrantRepositoryLive = Layer.effect(
  GrantRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);

    const find = SqlSchema.findOneOption({
      Request: GrantId,
      Result: Grant,
      execute: (id) => sql`SELECT * FROM grants WHERE id = ${id}`.pipe(Effect.map(grantRows)),
    });
    const list = SqlSchema.findAll({
      Request: Schema.NullOr(Schema.String),
      Result: Grant,
      execute: (agentId) =>
        (agentId === null
          ? sql`SELECT * FROM grants ORDER BY ${oldestFirst(sql)}`
          : sql`SELECT * FROM grants WHERE agent_id = ${agentId} ORDER BY ${oldestFirst(sql)}`
        ).pipe(Effect.map(grantRows)),
    });
    const forApproval = SqlSchema.findAll({
      Request: Schema.String,
      Result: Grant,
      execute: (approvalId) =>
        sql`SELECT * FROM grants WHERE approval_id = ${approvalId} ORDER BY ${oldestFirst(sql)}`.pipe(
          Effect.map(grantRows),
        ),
    });

    // Only a live grant is revoked, so a user's removal and the hub's revocation never both apply.
    const revoke = (input: Grant) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const grant = new Grant({ ...input, revision });
          const updated = yield* sql`UPDATE grants
            SET revoked_at = ${grant.revokedAt}, revoked_by = ${grant.revokedBy},
              revoke_reason = ${grant.revokeReason}, revision = ${revision}
            WHERE id = ${grant.id} AND revoked_at IS NULL RETURNING id`;
          if (updated.length === 0) return null;
          return { value: grant, events: [{ _tag: "GrantRevoked", grant } as const] };
        }),
      );

    const touch = (ids: ReadonlyArray<GrantId>, at: string) =>
      ids.length === 0
        ? Effect.void
        : sql`UPDATE grants SET last_used_at = ${at} WHERE ${sql.in("id", ids)}`.pipe(Effect.asVoid, Effect.orDie);

    return GrantRepository.of({
      find: (id) => find(id).pipe(Effect.orDie),
      list: (agentId) => list(agentId ?? null).pipe(Effect.orDie),
      forApproval: (approvalId) => forApproval(approvalId).pipe(Effect.orDie),
      revoke,
      touch,
    });
  }),
);
