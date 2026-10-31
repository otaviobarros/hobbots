import { ApprovalRepository } from "@hobbots/agents";
import { ApprovalRequest, type ApprovalState } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { makeJournaled } from "./journal.ts";

interface ApprovalRow {
  readonly targets?: unknown;
  readonly arguments?: unknown;
  readonly revision?: unknown;
}

// Targets and arguments are JSON text (migration 0017); the revision is a bigint on PostgreSQL.
const approvalRows = (rows: ReadonlyArray<ApprovalRow>) =>
  rows.map((row) => ({
    ...row,
    targets: JSON.parse(String(row.targets)),
    arguments: JSON.parse(String(row.arguments)),
    revision: Number(row.revision),
  }));

/** The SQL store of approval requests, for SQLite and PostgreSQL (ADR 011). */
export const ApprovalRepositoryLive = Layer.effect(
  ApprovalRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    // Oldest first; text compares byte by byte on both, as the other repositories' sort keys do.
    const oldestFirst = sql.onDialectOrElse({
      pg: () => sql.literal(`created_at COLLATE "C", id COLLATE "C"`),
      orElse: () => sql.literal("created_at, id"),
    });

    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ApprovalRequest,
      execute: (id) => sql`SELECT * FROM approval_requests WHERE id = ${id}`.pipe(Effect.map(approvalRows)),
    });
    const listForThread = SqlSchema.findAll({
      Request: Schema.String,
      Result: ApprovalRequest,
      execute: (threadId) =>
        sql`SELECT * FROM approval_requests WHERE thread_id = ${threadId} ORDER BY ${oldestFirst}`.pipe(
          Effect.map(approvalRows),
        ),
    });
    const listPending = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ApprovalRequest,
      execute: () =>
        sql`SELECT * FROM approval_requests WHERE state = 'pending' ORDER BY ${oldestFirst}`.pipe(
          Effect.map(approvalRows),
        ),
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
            state: approval.state,
            deny_reason: approval.denyReason,
            created_at: approval.createdAt,
            decided_at: approval.decidedAt,
            revision,
          })}`;
          return { value: approval, events: [{ _tag: "ApprovalRequested", approval } as const] };
        }),
      ).pipe(Effect.map(Option.getOrThrow));

    // The state check lets a decision and an expiry race safely: only one moves it out of `from`.
    const resolve = (input: ApprovalRequest, from: ApprovalState) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const approval = new ApprovalRequest({ ...input, revision });
          const updated = yield* sql`UPDATE approval_requests
            SET state = ${approval.state}, deny_reason = ${approval.denyReason},
              decided_at = ${approval.decidedAt}, revision = ${revision}
            WHERE id = ${approval.id} AND state = ${from} RETURNING id`;
          if (updated.length === 0) return null;
          return { value: approval, events: [{ _tag: "ApprovalResolved", approval } as const] };
        }),
      );

    return ApprovalRepository.of({
      find: (id) => find(id).pipe(Effect.orDie),
      listForThread: (threadId) => listForThread(threadId).pipe(Effect.orDie),
      listPending: listPending().pipe(Effect.orDie),
      insert,
      resolve,
    });
  }),
);
