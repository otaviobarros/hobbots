import { HobProposalLog } from "@hobbots/agents";
import { HobProposal } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { UnwaitedApprovals } from "./backpack-rows.ts";
import { makeJournaled } from "./journal.ts";
import { firstRow, sqlOrDie } from "./sql-errors.ts";

interface Row {
  readonly id: string;
  readonly agentId: string;
  readonly kind: string;
  readonly tool: string;
  readonly scope: string;
  readonly callKey: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly taskId: string | null;
  readonly stepId: string | null;
  readonly rows: string;
  readonly asks: string;
  readonly safety: string | null;
  readonly highRisk: number | boolean;
  readonly alwaysAllowed: string;
  readonly state: string;
  readonly revision: number | string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt: string | null;
}

const decode = Schema.decodeUnknownEffect(HobProposal);

const fromRow = (row: Row) =>
  decode({
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    tool: row.tool,
    call: { scope: row.scope, key: row.callKey },
    threadId: row.threadId,
    messageId: row.messageId,
    taskId: row.taskId,
    stepId: row.stepId,
    rows: JSON.parse(row.rows),
    asks: JSON.parse(row.asks),
    safety: row.safety,
    highRisk: Boolean(Number(row.highRisk)),
    alwaysAllowed: JSON.parse(row.alwaysAllowed),
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    settledAt: row.settledAt,
    revision: Number(row.revision),
  }).pipe(Effect.orDie);

const toRow = (proposal: HobProposal) => ({
  id: proposal.id,
  agent_id: proposal.agentId,
  kind: proposal.kind,
  tool: proposal.tool,
  scope: proposal.call.scope,
  call_key: proposal.call.key,
  thread_id: proposal.threadId,
  message_id: proposal.messageId,
  task_id: proposal.taskId,
  step_id: proposal.stepId,
  rows: JSON.stringify(proposal.rows),
  asks: JSON.stringify(proposal.asks),
  safety: proposal.safety,
  high_risk: proposal.highRisk ? 1 : 0,
  always_allowed: JSON.stringify(proposal.alwaysAllowed),
  state: proposal.state,
  revision: proposal.revision,
  created_at: proposal.createdAt,
  updated_at: proposal.updatedAt,
  settled_at: proposal.settledAt,
});

/**
 * The SQL record of hob proposals (migration 0089). A proposal is recorded and journaled in one
 * transaction; every later change is one conditional update on its revision, so of two decisions
 * racing for one proposal only the first lands.
 */
export const HobProposalLogLive = Layer.effect(
  HobProposalLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const rows = (found: ReadonlyArray<Row>) => Effect.forEach(found, fromRow);

    return HobProposalLog.of({
      insert: (input) =>
        journaled(1, (revision) =>
          Effect.gen(function* () {
            const proposal = new HobProposal({ ...input, revision });
            yield* sql`INSERT INTO hob_proposals ${sql.insert(toRow(proposal))}`;
            return { value: proposal, events: [{ _tag: "HobProposalRequested", proposal }] as const };
          }),
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die(new Error("A new hob proposal changed nothing.")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      get: (id) => firstRow(sql<Row>`SELECT * FROM hob_proposals WHERE id = ${id}`, fromRow),
      byCall: (agentId, scopes, key) =>
        firstRow(
          sql<Row>`SELECT * FROM hob_proposals
            WHERE agent_id = ${agentId} AND ${sql.in("scope", [...scopes])} AND call_key = ${key}
            ORDER BY created_at LIMIT 1`,
          fromRow,
        ),
      move: (next, options = {}) =>
        journaled(1, (revision) =>
          Effect.gen(function* () {
            const proposal = new HobProposal({ ...next, revision });
            const row = toRow(proposal);
            const updated = yield* sql`UPDATE hob_proposals SET
                rows = ${row.rows}, always_allowed = ${row.always_allowed}, state = ${row.state},
                revision = ${row.revision}, updated_at = ${row.updated_at}, settled_at = ${row.settled_at}
              WHERE id = ${proposal.id} AND revision = ${next.revision} RETURNING id`;
            if (updated.length === 0) return null;
            return { value: proposal, events: [{ _tag: "HobProposalChanged", proposal }] as const };
          }),
        ).pipe(Effect.provideService(UnwaitedApprovals, options.unwaited === true)),
      list: (settled) =>
        sqlOrDie(
          Effect.gen(function* () {
            const open = yield* sql<Row>`SELECT * FROM hob_proposals WHERE state = 'open' ORDER BY created_at`;
            const closed =
              settled <= 0
                ? []
                : yield* sql<Row>`SELECT * FROM hob_proposals WHERE state = 'settled'
                    ORDER BY settled_at DESC LIMIT ${settled}`;
            return [...(yield* rows(open)), ...(yield* rows(closed))];
          }),
        ),
    });
  }),
);
