import { proposalLimit, SkillProposalLog } from "@hobbots/agents";
import { SkillFeedback, SkillProposal, type SkillProposalState } from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { lockJournal, makeJournaled } from "./journal.ts";
import { firstRow, sqlOrDie } from "./sql-errors.ts";

interface Row {
  readonly id: string;
  readonly agentId: string;
  readonly scope: string;
  readonly callKey: string;
  readonly input: string;
  readonly name: string;
  readonly description: string;
  readonly skillId: string | null;
  readonly baseHash: string | null;
  readonly baseNumber: number | string | null;
  readonly instructions: string;
  readonly why: string;
  readonly state: string;
  readonly edited: number | boolean;
  readonly addedHash: string | null;
  readonly addedNumber: number | string | null;
  readonly addedAs: string | null;
  readonly plannedHash: string | null;
  readonly plannedAfter: string | null;
  readonly plannedAs: string | null;
  readonly memoryPages: string;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly attemptId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

interface FeedbackRow {
  readonly id: string;
  readonly agentId: string;
  readonly skillId: string;
  readonly kind: string;
  readonly note: string;
  readonly revision: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly createdAt: string;
}

const decodeProposal = Schema.decodeUnknownEffect(SkillProposal);
const decodeFeedback = Schema.decodeUnknownEffect(SkillFeedback);

const refOf = (hash: string | null, number: number | string | null) =>
  hash === null || number === null ? null : { hash, number: Number(number) };

const addedOf = (row: Row) => {
  const ref = refOf(row.addedHash, row.addedNumber);
  return ref === null ? null : { ...ref, as: row.addedAs };
};

const fromRow = (row: Row) =>
  decodeProposal({
    id: row.id,
    agentId: row.agentId,
    work: row.scope,
    key: row.callKey,
    input: row.input,
    name: row.name,
    description: row.description,
    skillId: row.skillId,
    base: refOf(row.baseHash, row.baseNumber),
    instructions: row.instructions,
    why: row.why,
    state: row.state,
    edited: Boolean(Number(row.edited)),
    added: addedOf(row),
    planned: row.plannedHash === null ? null : { hash: row.plannedHash, after: row.plannedAfter, as: row.plannedAs },
    memoryPages: JSON.parse(row.memoryPages),
    threadId: row.threadId,
    messageId: row.messageId,
    attemptId: row.attemptId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
  }).pipe(Effect.orDie);

/** The revision a proposal became, and what an add in progress writes. */
const addedRow = ({ added, planned }: SkillProposal) => ({
  added_hash: added?.hash ?? null,
  added_number: added?.number ?? null,
  added_as: added?.as ?? null,
  planned_hash: planned?.hash ?? null,
  planned_after: planned?.after ?? null,
  planned_as: planned?.as ?? null,
});

const toRow = (proposal: SkillProposal) => ({
  id: proposal.id,
  agent_id: proposal.agentId,
  scope: proposal.work,
  call_key: proposal.key,
  input: proposal.input,
  name: proposal.name,
  description: proposal.description,
  skill_id: proposal.skillId,
  base_hash: proposal.base?.hash ?? null,
  base_number: proposal.base?.number ?? null,
  instructions: proposal.instructions,
  why: proposal.why,
  state: proposal.state,
  edited: proposal.edited ? 1 : 0,
  ...addedRow(proposal),
  memory_pages: JSON.stringify(proposal.memoryPages),
  thread_id: proposal.threadId,
  message_id: proposal.messageId,
  attempt_id: proposal.attemptId,
  created_at: proposal.createdAt,
  updated_at: proposal.updatedAt,
  decided_at: proposal.decidedAt,
});

const OPEN: ReadonlyArray<SkillProposalState> = ["waiting", "adding"];
const DECIDED: ReadonlyArray<SkillProposalState> = ["added", "declined"];

/**
 * The SQL record of skill proposals and feedback (migration 0068). A proposal is recorded and
 * journaled in one transaction, with the journal's head taken first, so two calls with one key, or
 * two proposals that would pass the limits only one at a time, take turns on PostgreSQL and only the
 * first is recorded. Every later change is one conditional update, so of two decisions racing for a
 * proposal only the first lands.
 */
export const SkillProposalLogLive = Layer.effect(
  SkillProposalLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const rows = (found: ReadonlyArray<Row>) => Effect.forEach(found, fromRow);

    /** The proposal a hob made with `key` in `work` or `also`, the first one when both have one. */
    const byKey = (agentId: string, key: string, work: string, also?: string) =>
      sql<Row>`SELECT * FROM skill_proposals
        WHERE agent_id = ${agentId} AND ${sql.in("scope", [work, also ?? work])} AND call_key = ${key}
        ORDER BY created_at LIMIT 1`;

    const begin = (proposal: SkillProposal, also?: string) =>
      Effect.gen(function* () {
        yield* lockJournal(sql);
        const [stored] = yield* byKey(proposal.agentId, proposal.key, proposal.work, also);
        if (stored !== undefined) return { _tag: "Existing", proposal: yield* fromRow(stored) } as const;
        const open = yield* rows(
          yield* sql<Row>`SELECT * FROM skill_proposals
            WHERE agent_id = ${proposal.agentId} AND ${sql.in("state", [...OPEN])} ORDER BY created_at`,
        );
        const limited = proposalLimit(open, proposal);
        if (limited !== null) return limited;
        const committed = yield* journaled(1, () =>
          sql`INSERT INTO skill_proposals ${sql.insert(toRow(proposal))}`.pipe(
            Effect.as({ value: proposal, events: [{ _tag: "SkillProposalRequested", proposal }] as const }),
          ),
        );
        return { _tag: "Started", entries: Option.isSome(committed) ? committed.value.entries : [] } as const;
      }).pipe(sql.withTransaction, sqlOrDie);

    return SkillProposalLog.of({
      begin,
      recorded: (agentId, key, work, also) => firstRow(byKey(agentId, key, work, also), fromRow),
      move: (proposal, from) =>
        journaled(1, () =>
          Effect.gen(function* () {
            const row = toRow(proposal);
            const [updated] = yield* sql<Row>`
              UPDATE skill_proposals SET
                instructions = ${row.instructions}, description = ${row.description}, state = ${row.state},
                edited = ${row.edited}, added_hash = ${row.added_hash}, added_number = ${row.added_number},
                added_as = ${row.added_as}, planned_hash = ${row.planned_hash},
                planned_after = ${row.planned_after}, planned_as = ${row.planned_as},
                updated_at = ${row.updated_at}, decided_at = ${row.decided_at}
              WHERE id = ${proposal.id} AND ${sql.in("state", [...from])}
              RETURNING *`;
            if (updated === undefined) return null;
            const moved = yield* fromRow(updated);
            return { value: moved, events: [{ _tag: "SkillProposalChanged", proposal: moved }] as const };
          }),
        ),
      get: (id) => firstRow(sql<Row>`SELECT * FROM skill_proposals WHERE id = ${id}`, fromRow),
      list: (decided) =>
        sqlOrDie(
          Effect.gen(function* () {
            const open = yield* sql<Row>`SELECT * FROM skill_proposals
              WHERE ${sql.in("state", [...OPEN])} ORDER BY created_at`;
            const closed =
              decided <= 0
                ? []
                : yield* sql<Row>`SELECT * FROM skill_proposals
                    WHERE ${sql.in("state", [...DECIDED])}
                    ORDER BY updated_at DESC LIMIT ${decided}`;
            return [...(yield* rows(open)), ...(yield* rows(closed))];
          }),
        ),
      leaveFeedback: (feedback) =>
        journaled(1, () =>
          sql`INSERT INTO skill_feedback ${sql.insert({
            id: feedback.id,
            agent_id: feedback.agentId,
            skill_id: feedback.skillId,
            kind: feedback.kind,
            note: feedback.note,
            revision: feedback.revision,
            thread_id: feedback.threadId,
            message_id: feedback.messageId,
            created_at: feedback.createdAt,
          })}`.pipe(Effect.as({ value: feedback, events: [{ _tag: "SkillFeedbackLeft", feedback }] as const })),
        ).pipe(
          // An insert always writes, so it always commits.
          Effect.flatMap((committed) =>
            Option.isSome(committed) ? Effect.succeed(committed.value) : Effect.die("The note was not recorded."),
          ),
        ),
      feedback: (skillId) =>
        sqlOrDie(
          sql<FeedbackRow>`SELECT * FROM skill_feedback WHERE skill_id = ${skillId} ORDER BY created_at DESC`.pipe(
            Effect.flatMap((found) => Effect.forEach(found, (row) => decodeFeedback(row).pipe(Effect.orDie))),
          ),
        ),
    });
  }),
);
