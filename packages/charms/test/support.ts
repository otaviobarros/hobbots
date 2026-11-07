import { type ApprovalAction, actionDigest, FolderSandbox, type ToolAccess, type TurnApprovals } from "@hobbots/agents";
import { AgentId, ApprovalId, type ApprovalLifetime, Grant, GrantId, ruleOperation } from "@hobbots/domain";
import { Context, Effect, Layer, Redacted } from "effect";
import { GitHubCredential, GitHubError } from "../src/index.ts";

export { charmTakeoversFor, charmToolsFor, memoryCharmCalls } from "@hobbots/agents/testing";

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

/**
 * A user who approves every request with `lifetime`, and the grants they save: a This Task or Always
 * approval of a grantable request saves its rules as grants, which answer the hob's later calls.
 */
export const approvingUser = (access: ToolAccess, lifetime: ApprovalLifetime) => {
  const asked: Array<ApprovalAction> = [];
  const grants: Array<Grant> = [];
  const approvals: TurnApprovals = {
    request: (action) =>
      Effect.gen(function* () {
        asked.push(action);
        const saves = lifetime !== "once" && action.grantable;
        for (const rule of saves ? action.rules : []) {
          grants.push(
            new Grant({
              id: GrantId.make(`grant-${grants.length + 1}`),
              agentId: AgentId.make("hob"),
              operation: ruleOperation(rule),
              rule,
              lifetime: lifetime === "task" ? "task" : "always",
              taskId: null,
              approvalId: ApprovalId.make(`approval-${asked.length}`),
              grantedBy: "user",
              createdAt: "2026-11-07T00:00:00.000Z",
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
              revokedBy: null,
              revokeReason: null,
            }),
          );
        }
        const digest = yield* actionDigest(action);
        return {
          approvalId: ApprovalId.make(`approval-${asked.length}`),
          decision: Effect.succeed({
            _tag: "Approved" as const,
            actionDigest: digest,
            policyVersion: action.policyVersion,
            lifetime: saves ? lifetime : "once",
          }),
        };
      }),
    currentAccess: Effect.succeed(access),
    grants: Effect.sync(() => [...grants]),
    used: () => Effect.void,
  };
  return { approvals, asked, grants };
};
