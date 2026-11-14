import { type ClaimOutcome, ClaimRegister, type ClaimRequest, type TakeOverRequest } from "@hobbots/agents";
import {
  AgentId,
  Claim,
  ClaimClash,
  Claims,
  ClashSide,
  clashGroups,
  isSequenceScope,
  type JournaledEvent,
  pickNumber,
  sinceOf,
  type ThreadId,
  ThreadId as ThreadIds,
} from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { type ClaimRow, claimsFromRows, claimToRow, movedClaim, saveClaim } from "./claim-rows.ts";
import { makeJournaledChange } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

/** A Task a claim names, as a clash shows who holds it. */
interface TaskHolder {
  readonly id: string;
  readonly ownerId: string;
  readonly brief: string;
  readonly threadId: string | null;
}

/**
 * The SQL claims register (ADR 037, migration 0098). A claim takes the journal's head first, so two
 * claims for one number, from any hub process sharing the database, take turns: the second reads
 * the first and gets the next number. Unique indexes hold each number once per folder of a
 * repository, ever, and a path or branch once per Task. A claim you take over (#1449) keeps its row,
 * with you as its actor.
 */
export const ClaimRegisterLive = Layer.effect(
  ClaimRegister,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const change = makeJournaledChange(sql);

    /** The open claims of other Tasks on the same scope in the same repository. */
    const openOn = (request: ClaimRequest) =>
      Effect.flatMap(
        sql<ClaimRow>`SELECT * FROM claims WHERE scope = ${request.scope} AND repository = ${request.repository}
          AND state <> 'released' ORDER BY created_at, id`,
        claimsFromRows,
      );

    /** The key a new claim takes: the path or branch asked for, or the number the register picks. */
    const keyOf = (request: ClaimRequest) =>
      Effect.gen(function* () {
        if (!isSequenceScope(request.scope) || request.directory === null) {
          return { key: request.key ?? "", taken: null };
        }
        // Released claims count too: a number is never handed out twice.
        const rows = yield* sql<{ readonly claimKey: string }>`SELECT claim_key FROM claims
          WHERE repository = ${request.repository} AND directory = ${request.directory}`;
        const pick = pickNumber({
          onMain: request.onMain,
          claimed: rows.map((row) => Number(row.claimKey)),
          asked: request.asked,
        });
        return { key: String(pick.number), taken: pick.taken };
      });

    const claim = (request: ClaimRequest) =>
      change<ClaimOutcome, never>((first) =>
        Effect.gen(function* () {
          const open = yield* openOn(request);
          const own = open.find((each) => each.taskId === request.taskId && each.key === request.key);
          if (own !== undefined && !isSequenceScope(request.scope)) {
            const held: ClaimOutcome = { _tag: "Held", claim: own, clashes: Claims.clashesOf(own, open) };
            return { value: held, events: [] as ReadonlyArray<JournaledEvent> };
          }
          const { key, taken } = yield* keyOf(request);
          const made = new Claim({
            id: request.id,
            scope: request.scope,
            repository: request.repository,
            directory: request.directory,
            key,
            taskId: request.taskId,
            actor: request.actor,
            state: "held",
            createdAt: request.at,
            updatedAt: request.at,
            releasedAt: null,
            revision: first,
          });
          const found = Claims.clashesOf(made, open);
          // A contested claim already is, and one you took over stays yours (#1449).
          const fresh = found.filter(Claims.contestable);
          // Each held claim it clashes with is contested now, at the sequences after the new claim's.
          const contested = fresh.map((each, index) =>
            movedClaim(each, { _tag: "Contest", at: request.at }, first + 1 + index),
          );
          const clashes = found.map((each) => contested.find((moved) => moved.id === each.id) ?? each);
          const claimed = found.length === 0 ? made : movedClaim(made, { _tag: "Contest", at: request.at }, first);
          yield* sql`INSERT INTO claims ${sql.insert(claimToRow(claimed))}`;
          for (const each of contested) yield* saveClaim(sql, each);
          const value: ClaimOutcome = { _tag: "Made", claim: claimed, clashes, taken };
          return {
            value,
            events: [
              { _tag: "ClaimMade" as const, claim: claimed, clashes },
              ...contested.map((each) => ({ _tag: "ClaimContested" as const, claim: each })),
            ],
          };
        }),
      );

    /** Who holds each Task's claims, its brief and the thread of its top Task. */
    const holders = (taskIds: ReadonlyArray<string>) =>
      taskIds.length === 0
        ? Effect.succeed(new Map<string, TaskHolder>())
        : Effect.map(
            sql<TaskHolder>`SELECT t.id, t.owner_id, t.brief, r.thread_id FROM tasks t
              JOIN tasks r ON r.id = t.root_id WHERE ${sql.in("t.id", taskIds)}`,
            (rows) => new Map(rows.map((row) => [row.id, row])),
          );

    const clashesIn = (threadId: ThreadId) =>
      Effect.gen(function* () {
        // Only a contested claim clashes; the thread's are those of Tasks whose top Task is in it.
        const ours = yield* Effect.flatMap(
          sql<ClaimRow>`SELECT c.* FROM claims c JOIN tasks t ON t.id = c.task_id JOIN tasks r ON r.id = t.root_id
            WHERE r.thread_id = ${threadId} AND c.state = 'contested' ORDER BY c.created_at, c.id`,
          claimsFromRows,
        );
        if (ours.length === 0) return [];
        const open = yield* Effect.flatMap(
          sql<ClaimRow>`SELECT * FROM claims WHERE state <> 'released' AND scope <> 'sequence'
            ORDER BY created_at, id`,
          claimsFromRows,
        );
        const groups = clashGroups(ours, open);
        const tasks = yield* holders([...new Set(groups.flat().map((claim) => claim.taskId))]);
        return groups.map(
          (group) =>
            new ClaimClash({
              since: sinceOf(group),
              sides: group.flatMap((claim) => {
                const task = tasks.get(claim.taskId);
                return task === undefined
                  ? []
                  : [
                      new ClashSide({
                        claim,
                        ownerId: AgentId.make(task.ownerId),
                        brief: task.brief,
                        threadId: task.threadId === null ? null : ThreadIds.make(task.threadId),
                      }),
                    ];
              }),
            }),
        );
      });

    /**
     * Moves the Task's open claims to you (#1449), each at its own sequence with its own event, in
     * one transaction: its hob hears of it through its backpack, from the same change. Claims you
     * already took over stay as they are, so taking over again changes nothing.
     */
    const takeOver = (request: TakeOverRequest) =>
      change<ReadonlyArray<Claim>, never>((first) =>
        Effect.gen(function* () {
          const open = yield* claimsFromRows(
            yield* sql<ClaimRow>`SELECT * FROM claims WHERE task_id = ${request.taskId} AND state <> 'released'
              ORDER BY created_at, id`,
          );
          const event = { _tag: "TakeOver" as const, at: request.at, by: request.by };
          const taken = open
            .filter((claim) => Claims.can(claim, event))
            .map((claim, index) => movedClaim(claim, event, first + index));
          for (const claim of taken) yield* saveClaim(sql, claim);
          return {
            value: taken,
            events: taken.map((claim) => ({ _tag: "ClaimTakenOver" as const, claim })),
          };
        }),
      );

    return ClaimRegister.of({
      takeOver,
      takenIn: (repository) =>
        sqlOrDie(
          Effect.flatMap(
            sql<ClaimRow>`SELECT * FROM claims WHERE repository = ${repository} AND state = 'taken'
              ORDER BY created_at, id`,
            claimsFromRows,
          ),
        ),
      clashesIn: (threadId) => sqlOrDie(clashesIn(threadId)),
      claim,
      ofTask: (taskId) =>
        sqlOrDie(
          Effect.flatMap(
            sql<ClaimRow>`SELECT * FROM claims WHERE task_id = ${taskId} ORDER BY created_at, id`,
            claimsFromRows,
          ),
        ),
    });
  }),
);
