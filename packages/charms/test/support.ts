import { CharmCalls, FolderSandbox } from "@hobbots/agents";
import { CharmCall, isCharmCallSettled } from "@hobbots/domain";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { GitHubCredential, GitHubError } from "../src/index.ts";

/** Charm call records in memory, with the rules of the SQL ones (migrations 0028 and 0045), by hob, scope and key. */
const idOf = (agentId: string, scope: string, key: string) => `${agentId} ${scope} ${key}`;

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
      hobApp: () => Effect.succeed(null),
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
