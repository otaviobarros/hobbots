import {
  type AgentId,
  type CommitIdentity,
  type CommitsAs,
  type GitHubUser,
  type GitIdentity,
  githubUserCommitIdentity,
  type HubQuestion,
  type HubQuestionChat,
  parseCommitIdentity,
  type QuestionOption,
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
const SUBJECT = { kind: KIND, key: "user", title: "Who hobs commit as" } as const;

/** The choice that leaves it to your own Git config. */
export const OWN_GIT_LABEL = "I'll set it in Git myself";
const OWN_GIT: QuestionOption = {
  label: OWN_GIT_LABEL,
  consequence:
    "Run git config --global user.name and user.email on the hub's computer. Hobs use them from their next turn.",
};

// The GitHub choice names the identity it commits as, in a shape the answer is read back from.
const GITHUB_PREFIX = "Commits are made as ";
const GITHUB_SUFFIX = ", which GitHub links to your account.";
const githubOption = (user: GitHubUser): QuestionOption | null => {
  const identity = githubUserCommitIdentity(user);
  const consequence = `${GITHUB_PREFIX}${identity.name} <${identity.email}>${GITHUB_SUFFIX}`;
  return consequence.length > 200 ? null : { label: `My GitHub account, @${user.login}`, consequence };
};
const githubIdentityIn = (option: QuestionOption | undefined): CommitIdentity | null =>
  option?.consequence.startsWith(GITHUB_PREFIX) && option.consequence.endsWith(GITHUB_SUFFIX)
    ? parseCommitIdentity(option.consequence.slice(GITHUB_PREFIX.length, -GITHUB_SUFFIX.length))
    : null;

const EXAMPLE = "Ada Lovelace <ada@example.com>";
const WHY =
  "Your Git config sets no name and email, so hobs that commit as you can't commit, and they may not set one themselves.";

/** The question, with your GitHub account (`github`) as the recommended choice when the hub reaches one. */
const commitIdentityQuestion = (
  github: QuestionOption | null,
  chat: HubQuestionChat | null,
  unread?: string,
): RaiseHubQuestion => {
  const lead = unread === undefined ? WHY : `Hobbots couldn't find a name and email in "${unread.slice(0, 200)}".`;
  const where = chat === null ? {} : { chat };
  return github === null
    ? {
        subject: SUBJECT,
        ...where,
        text: `${lead} Who should hobs commit as? Type a name and email, such as ${EXAMPLE}. Or set user.name and user.email with git config --global on the hub's computer, then answer "done".`,
      }
    : {
        subject: SUBJECT,
        ...where,
        text: `${lead} Who should hobs commit as? Pick one, or type a name and email, such as ${EXAMPLE}.`,
        options: [github, OWN_GIT],
        recommended: 0,
      };
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
        if (open.some((question) => question.subject.kind === KIND)) return true;
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
              yield* questions.raise(commitIdentityQuestion(user === null ? null : githubOption(user), chat));
            }),
          );
        });

      const apply = (question: HubQuestion) =>
        Effect.gen(function* () {
          const picked = question.picked === null ? undefined : question.options[question.picked];
          if (picked?.label === OWN_GIT_LABEL) return;
          const identity = githubIdentityIn(picked) ?? parseCommitIdentity(question.answer ?? "");
          if (identity !== null) {
            yield* identities.save(identity, DateTime.formatIso(yield* DateTime.now));
            return;
          }
          // An answer such as "done" after setting it in Git needs nothing more; anything else is asked
          // again, with the same GitHub choice, in the same chat.
          if ((yield* git.read).email !== null) return;
          const again = question.options.find((option) => githubIdentityIn(option) !== null) ?? null;
          yield* questions.raise(commitIdentityQuestion(again, question.chat, question.answer ?? ""));
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
