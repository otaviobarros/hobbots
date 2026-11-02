import { CharmCalls, FolderSandbox } from "@hobbots/agents";
import { CharmCall, isCharmCallSettled } from "@hobbots/domain";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { GitHubCredential, GitHubError } from "../src/index.ts";

/** Charm call records in memory, with the rules of the SQL ones (migration 0028). */
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
      settle: (call, state, result, at) =>
        Effect.sync(() => {
          const id = `${call.agentId} ${call.key}`;
          const stored = rows.get(id);
          if (stored === undefined || stored.attempt !== call.attempt || isCharmCallSettled(stored.state)) {
            return Option.none();
          }
          const next = new CharmCall({ ...stored, state, result, updatedAt: at });
          rows.set(id, next);
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

/** The sign-in a call was pinned to, as the hub's credential keeps it. */
const PinnedSignIn = Context.Reference<number | null>("@hobbots/charms/test/PinnedSignIn", {
  defaultValue: () => null,
});

/**
 * GitHub connected on the hub with `token` for every hob, reaching every repository. `fresh` is
 * handed out after GitHub refused a token, as a refresh would. `switchAccount` connects another
 * account, which fails whatever was pinned to the one before, as the hub's credential does.
 */
export const fixedCredential = (token: string, fresh: string = token) => {
  const revoked: Array<string> = [];
  let signIn = 0;
  const current = Effect.gen(function* () {
    const pinned = yield* PinnedSignIn;
    if (pinned !== null && pinned !== signIn) {
      return yield* new GitHubError({
        reason: "signed-out",
        message: "The hub's GitHub sign-in changed during this call, so it did not run. Try again.",
      });
    }
    return signIn;
  });
  const layer = Layer.succeed(
    GitHubCredential,
    GitHubCredential.of({
      connected: Effect.succeed(true),
      tokenFor: () => current.pipe(Effect.as(Redacted.make(token))),
      refused: () => current.pipe(Effect.as(Redacted.make(fresh))),
      revoked: (refused) => Effect.sync(() => void revoked.push(Redacted.value(refused))),
      reaches: () => Effect.void,
      onRepository: (_agentId, _repository, use) =>
        Effect.flatMap(current, (started) => Effect.provideService(use, PinnedSignIn, started)),
    }),
  );
  return {
    layer,
    revoked,
    switchAccount: () => {
      signIn += 1;
    },
  };
};
