import {
  type AgentId,
  type CommitIdentityAsk,
  type CommitsAs,
  type GitHubUser,
  type GitIdentity,
  githubUserCommitIdentity,
  type HubQuestion,
  type HubQuestionChat,
  parseCommitIdentity,
  type RaiseHubQuestion,
  settleCommitsAs,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Semaphore } from "effect";
import { type HubQuestionHandler, HubQuestionRepository, HubQuestions } from "./hub-questions.ts";
import { HubCommitIdentities } from "./ports.ts";

/**
 * Who hobs on the user's account commit as when the user's Git config sets no identity (#741). A
 * hob may never set one itself (#700), so the hub asks you once, in the chat the work was asked in,
 * with your GitHub account recommended when one is connected. It keeps your answer, and every such
 * hob commits under it, on every runtime.
 */

/** The name and email the user's own Git config sets now, read where the hub runs. */
export class UserGitIdentity extends Context.Service<UserGitIdentity, { readonly read: Effect.Effect<GitIdentity> }>()(
  "@hobbots/agents/UserGitIdentity",
) {}

/**
 * The GitHub account the hub is connected to, as `agentId`'s turn reaches GitHub, or null when none
 * is connected or GitHub does not answer in time. It never fails.
 */
export class ConnectedGitHubUser extends Context.Service<
  ConnectedGitHubUser,
  { readonly get: (agentId: AgentId) => Effect.Effect<GitHubUser | null> }
>()("@hobbots/agents/ConnectedGitHubUser") {}

const KIND = "commit-identity";
const KEY = "user";

/**
 * The question, with your GitHub account (`user`) as the recommended choice when the hub reaches
 * one. The hub sends codes and data; the client words them (#1045). After an answer it could not
 * read, `unread` holds that answer and the hub says so.
 */
const commitIdentityQuestion = (
  user: CommitIdentityAsk["github"],
  chat: HubQuestionChat | null,
  unread?: string,
): RaiseHubQuestion => ({
  key: KEY,
  ...(chat === null ? {} : { chat }),
  ask: {
    kind: KIND,
    reason: unread === undefined ? "no-git-identity" : "unreadable-answer",
    github: user,
    unread: unread === undefined ? null : unread.slice(0, 200),
  },
  ...(user === null ? {} : { options: ["github", "own-git"], recommended: "github" }),
});

/** The GitHub account a question offers, with the identity its choice commits as; none past what a question holds. */
const githubChoice = (user: GitHubUser): CommitIdentityAsk["github"] => {
  const identity = githubUserCommitIdentity(user);
  return identity.name.length > 200 || identity.email.length > 200 ? null : { login: user.login, identity };
};

/** A turn about to start, and the chat a question about it concerns. */
export interface TurnStart {
  readonly chat: HubQuestionChat | null;
}

export class CommitIdentityQuestions extends Context.Service<
  CommitIdentityQuestions,
  {
    /**
     * Who a turn of `agentId`, a hob on your account, commits as: as your Git config sets you, as you
     * told the hub, or no one yet. For a turn about to start that may commit (`turn`) while neither
     * sets an identity, it asks you, one question at a time, in the turn's chat. Reading access at
     * any other time asks nothing.
     */
    readonly forTurn: (agentId: AgentId, turn?: TurnStart) => Effect.Effect<CommitsAs>;
  }
>()("@hobbots/agents/CommitIdentityQuestions") {
  static readonly layer = Layer.effect(
    CommitIdentityQuestions,
    Effect.gen(function* () {
      const identities = yield* HubCommitIdentities;
      const questions = yield* HubQuestions;
      const asked = yield* HubQuestionRepository;
      const git = yield* UserGitIdentity;
      const github = Option.getOrUndefined(yield* Effect.serviceOption(ConnectedGitHubUser));
      // Whether to ask is decided and the question raised under one permit, so two turns never both ask.
      const deciding = yield* Semaphore.make(1);

      /** Whether a question is open or an answer waits to be applied: the hub asks about it once at a time. */
      const pending = Effect.gen(function* () {
        const open = yield* questions.listOpen;
        if (open.some((question) => question.ask.kind === KIND)) return true;
        return (yield* asked.listUnapplied(KIND)).length > 0;
      });

      const ask = (agentId: AgentId, chat: HubQuestionChat | null) =>
        Effect.gen(function* () {
          if (yield* pending) return;
          // GitHub is read before the permit, since it can take seconds; everything is checked again after.
          const user = github === undefined ? null : yield* github.get(agentId);
          yield* Semaphore.withPermit(
            deciding,
            Effect.gen(function* () {
              if (yield* pending) return;
              // An answer is saved before it is marked applied, so one applied meanwhile is found here.
              if ((yield* identities.get) !== null || (yield* git.read).email !== null) return;
              yield* questions.raise(commitIdentityQuestion(user === null ? null : githubChoice(user), chat));
            }),
          );
        });

      const apply = (question: HubQuestion) =>
        Effect.gen(function* () {
          if (question.ask.kind !== KIND || question.picked === "own-git") return;
          const github = question.ask.github;
          // A choice is applied by its key (#1045); the GitHub one commits as the identity it named.
          const identity =
            question.picked === "github" && github !== null
              ? github.identity
              : parseCommitIdentity(question.answer ?? "");
          if (identity !== null) {
            yield* identities.save(identity, DateTime.formatIso(yield* DateTime.now));
            return;
          }
          // An answer such as "done" after setting it in Git needs nothing more; anything else is asked
          // again, with the same GitHub choice, in the same chat.
          if ((yield* git.read).email !== null) return;
          yield* questions.raise(commitIdentityQuestion(github, question.chat, question.answer ?? ""));
        });
      const handler: HubQuestionHandler = { kind: KIND, apply };
      yield* questions.handle(handler);

      return CommitIdentityQuestions.of({
        forTurn: (agentId, turn) =>
          Effect.gen(function* () {
            const userGitIdentity = yield* git.read;
            const userIdentity = yield* identities.get;
            if (turn !== undefined && userIdentity === null && userGitIdentity.email === null) {
              yield* ask(agentId, turn.chat).pipe(
                Effect.catchCause((cause) => Effect.logWarning("Could not ask who hobs commit as", cause)),
              );
            }
            return settleCommitsAs(null, userGitIdentity, userIdentity);
          }),
      });
    }),
  );
}
