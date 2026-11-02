import { CharmCalls, FolderSandbox } from "@hobbots/agents";
import { CharmCall, isCharmCallSettled } from "@hobbots/domain";
import { Effect, Layer, Option, Redacted } from "effect";
import { GitHubToken } from "../src/index.ts";

/** Charm call records in memory, with the rules of the SQL ones (migration 0027). */
export const memoryCharmCalls = (rows: Map<string, CharmCall> = new Map()) =>
  Layer.succeed(
    CharmCalls,
    CharmCalls.of({
      begin: (call) =>
        Effect.sync(() => {
          const id = `${call.agentId} ${call.key}`;
          const stored = rows.get(id);
          const replaces = stored?.state === "not-sent" && stored.input === call.input;
          if (stored !== undefined && !replaces) return { _tag: "Existing", call: stored } as const;
          const busy = [...rows.values()].find(
            (row) => row.tool === call.tool && row.site === call.site && !isCharmCallSettled(row.state),
          );
          if (busy !== undefined) return { _tag: "Blocked", call: busy } as const;
          rows.set(id, call);
          return { _tag: "Started" } as const;
        }),
      settle: (agentId, key, state, result, at) =>
        Effect.sync(() => {
          const stored = rows.get(`${agentId} ${key}`);
          if (stored === undefined || isCharmCallSettled(stored.state)) return Option.none();
          const next = new CharmCall({ ...stored, state, result, updatedAt: at });
          rows.set(`${agentId} ${key}`, next);
          return Option.some(next);
        }),
      find: (agentId, key) => Effect.sync(() => Option.fromUndefinedOr(rows.get(`${agentId} ${key}`))),
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

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Stands in for the hob's sandbox: runs the program as it is, so these tests check the hub's own
 * fence. Like the sandbox's launcher, it drops the arguments Git appends.
 */
export const directSandbox = Layer.succeed(
  FolderSandbox,
  FolderSandbox.of({
    readOnly: (_folders, program, args) =>
      Effect.succeed({ commandLine: `sh -c ${quote([program, ...args].map(quote).join(" "))}`, env: {} }),
  }),
);

export const fixedToken = (token: string) =>
  Layer.succeed(GitHubToken, GitHubToken.of({ get: Effect.succeed(Redacted.make(token)) }));
