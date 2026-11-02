import { ApprovalRepository } from "@hobbots/agents";
import { ApprovalRequest, type ApprovalState, type Grant } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { grantRow } from "./grants.ts";
import { makeJournaled } from "./journal.ts";
import { oldestFirst } from "./order.ts";

interface ApprovalRow {
  readonly targets?: unknown;
  readonly arguments?: unknown;
  readonly revision?: unknown;
  readonly onceOnly?: unknown;
  readonly grantable?: unknown;
  readonly rules?: unknown;
}

// Targets and arguments are JSON text (migration 0018); the revision is a bigint on PostgreSQL;
// once_only is 0 or 1 (migration 0019); grantable is 0 or 1 and rules are JSON text (migration 0022).
export const approvalRows = (rows: ReadonlyArray<ApprovalRow>) =>
  rows.map((row) => ({
    ...row,
    targets: JSON.parse(String(row.targets)),
    arguments: JSON.parse(String(row.arguments)),
    revision: Number(row.revision),
    onceOnly: Number(row.onceOnly) === 1,
    grantable: Number(row.grantable) === 1,
    rules: JSON.parse(String(row.rules ?? "[]")),
  }));

// The most recently closed first, bytewise on PostgreSQL as SQLite compares text, like `oldestFirst`.
const recentlyClosedFirst = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () => sql.literal(`COALESCE(decided_at, created_at) COLLATE "C" DESC, id COLLATE "C" DESC`),
    orElse: () => sql.literal("COALESCE(decided_at, created_at) DESC, id DESC"),
  });

/** The SQL store of approval requests, for SQLite and PostgreSQL (ADR 011). */
export const ApprovalRepositoryLive = Layer.effect(
  ApprovalRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);

    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ApprovalRequest,
      execute: (id) => sql`SELECT * FROM approval_requests WHERE id = ${id}`.pipe(Effect.map(approvalRows)),
    });
    const listForThread = SqlSchema.findAll({
      Request: Schema.String,
      Result: ApprovalRequest,
      execute: (threadId) =>
        sql`SELECT * FROM approval_requests WHERE thread_id = ${threadId} ORDER BY ${oldestFirst(sql)}`.pipe(
          Effect.map(approvalRows),
        ),
    });
    const listPending = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ApprovalRequest,
      execute: () =>
        sql`SELECT * FROM approval_requests WHERE state = 'pending' ORDER BY ${oldestFirst(sql)}`.pipe(
          Effect.map(approvalRows),
        ),
    });

    // One statement, so a request decided while it runs is read once, in one state.
    const listRecent = SqlSchema.findAll({
      Request: Schema.Number,
      Result: ApprovalRequest,
      execute: (limit) =>
        sql`SELECT * FROM approval_requests
          WHERE state = 'pending' OR id IN (
            SELECT id FROM approval_requests WHERE state <> 'pending' ORDER BY ${recentlyClosedFirst(sql)} LIMIT ${limit}
          )
          ORDER BY ${oldestFirst(sql)}`.pipe(Effect.map(approvalRows)),
    });

    const insert = (input: ApprovalRequest) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const approval = new ApprovalRequest({ ...input, revision });
          yield* sql`INSERT INTO approval_requests ${sql.insert({
            id: approval.id,
            agent_id: approval.agentId,
            thread_id: approval.threadId,
            message_id: approval.messageId,
            step_id: approval.stepId,
            tool: approval.tool,
            operation: approval.operation,
            targets: JSON.stringify(approval.targets),
            arguments: JSON.stringify(approval.arguments),
            label: approval.label,
            reason: approval.reason,
            action_digest: approval.actionDigest,
            policy_version: approval.policyVersion,
            once_only: approval.onceOnly ? 1 : 0,
            grantable: approval.grantable ? 1 : 0,
            rules: JSON.stringify(approval.rules),
            state: approval.state,
            lifetime: approval.lifetime,
            deny_reason: approval.denyReason,
            created_at: approval.createdAt,
            expires_at: approval.expiresAt,
            decided_at: approval.decidedAt,
            revision,
          })}`;
          return { value: approval, events: [{ _tag: "ApprovalRequested", approval } as const] };
        }),
      ).pipe(Effect.map(Option.getOrThrow));

    // The state check lets a decision and an expiry race safely: only one moves it out of `from`,
    // and only that one saves the decision's grants (ADR 015).
    const resolve = (input: ApprovalRequest, from: ApprovalState, grants: ReadonlyArray<Grant> = []) =>
      journaled(1 + grants.length, (revision) =>
        Effect.gen(function* () {
          const approval = new ApprovalRequest({ ...input, revision });
          const updated = yield* sql`UPDATE approval_requests
            SET state = ${approval.state}, lifetime = ${approval.lifetime}, deny_reason = ${approval.denyReason},
              decided_at = ${approval.decidedAt}, revision = ${revision}
            WHERE id = ${approval.id} AND state = ${from} RETURNING id`;
          if (updated.length === 0) return null;
          const saved = yield* Effect.forEach(grants, (grant, index) =>
            Effect.gen(function* () {
              const row = grantRow(grant, revision + 1 + index);
              yield* sql`INSERT INTO grants ${sql.insert(row.columns)}`;
              return row.grant;
            }),
          );
          return {
            value: approval,
            events: [
              { _tag: "ApprovalResolved", approval } as const,
              ...saved.map((grant) => ({ _tag: "GrantCreated", grant }) as const),
            ],
          };
        }),
      );

    return ApprovalRepository.of({
      find: (id) => find(id).pipe(Effect.orDie),
      listForThread: (threadId) => listForThread(threadId).pipe(Effect.orDie),
      listPending: listPending().pipe(Effect.orDie),
      listRecent: (limit) => listRecent(limit).pipe(Effect.orDie),
      insert,
      resolve,
    });
  }),
);
