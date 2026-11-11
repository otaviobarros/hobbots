import { type ClaimOutcome, ClaimRegister, type ClaimRequest } from "@hobbots/agents";
import { Claim, Claims, isSequenceScope, type JournaledEvent, pickNumber } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { type ClaimRow, claimsFromRows, claimToRow, movedClaim, saveClaim } from "./claim-rows.ts";
import { makeJournaledChange } from "./journal.ts";
import { sqlOrDie } from "./sql-errors.ts";

/**
 * The SQL claims register (ADR 037, migration 0097). A claim takes the journal's head first, so two
 * claims for one number, from any hub process sharing the database, take turns: the second reads
 * the first and gets the next number. Unique indexes hold each number once per folder of a
 * repository, ever, and a path or branch once per Task.
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
          const fresh = found.filter((each) => !Claims.isContested(each));
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

    return ClaimRegister.of({
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
