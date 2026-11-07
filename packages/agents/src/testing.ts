import { CharmCall, isCharmCallSettled } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { CharmCalls } from "./charm-calls.ts";

/** Test doubles for the agents package's ports, for this package's tests and its callers'. */

const idOf = (agentId: string, scope: string, key: string) => `${agentId} ${scope} ${key}`;

/** Charm call records in memory, with the rules of the SQL ones (migrations 0028 and 0045), by hob, scope and key. */
export const memoryCharmCalls = (rows: Map<string, CharmCall> = new Map()) => {
  /** `call`'s sending, by its attempt, in whatever scope it is now. */
  const sending = (call: CharmCall) =>
    [...rows.entries()].find(
      ([, row]) => row.agentId === call.agentId && row.key === call.key && row.attempt === call.attempt,
    );
  return Layer.succeed(
    CharmCalls,
    CharmCalls.of({
      begin: (call, also) =>
        Effect.sync(() => {
          const id = idOf(call.agentId, call.scope, call.key);
          const earlier = also === undefined ? undefined : rows.get(idOf(call.agentId, also, call.key));
          const stored = rows.get(id) ?? earlier;
          const replaces = stored?.state === "not-sent" && stored.input === call.input;
          if (stored !== undefined && !replaces) return { _tag: "Existing", call: stored } as const;
          const busy = [...rows.values()].find(
            (row) => row.tool === call.tool && row.site === call.site && !isCharmCallSettled(row.state),
          );
          if (busy !== undefined) return { _tag: "Blocked", call: busy } as const;
          if (replaces && stored.scope !== call.scope) rows.delete(idOf(call.agentId, stored.scope, call.key));
          rows.set(id, call);
          return { _tag: "Started" } as const;
        }),
      settle: (call, state, result, at) =>
        Effect.sync(() => {
          const [id, stored] = sending(call) ?? [];
          if (id === undefined || stored === undefined || isCharmCallSettled(stored.state)) return Option.none();
          const next = new CharmCall({ ...stored, state, result, updatedAt: at });
          rows.set(id, next);
          return Option.some(next);
        }),
      current: (call) => Effect.sync(() => Option.fromUndefinedOr(sending(call)?.[1])),
      find: (agentId, scopes, key) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            scopes.map((scope) => rows.get(idOf(agentId, scope, key))).find((row) => row !== undefined),
          ),
        ),
      findByStep: (threadId, messageId, stepId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            [...rows.values()].find(
              (row) => row.threadId === threadId && row.messageId === messageId && row.stepId === stepId,
            ),
          ),
        ),
      listForThread: (threadId) => Effect.sync(() => [...rows.values()].filter((row) => row.threadId === threadId)),
      unsettled: Effect.sync(() => [...rows.values()].filter((row) => !isCharmCallSettled(row.state))),
    }),
  );
};
