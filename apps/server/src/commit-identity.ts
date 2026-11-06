import { homedir } from "node:os";
import { HubCommitIdentities, type HubQuestionHandler, HubQuestionRepository, HubQuestions } from "@hobbots/agents";
import { GitHubApi } from "@hobbots/charms";
import {
  type AgentId,
  type CommitIdentity,
  type GitHubUser,
  githubUserCommitIdentity,
  type HubQuestion,
  parseCommitIdentity,
  type QuestionOption,
  type RaiseHubQuestion,
} from "@hobbots/domain";
import { type GitIdentity, userGitIdentity } from "@hobbots/runtimes";
import { Context, DateTime, Effect, Layer, Option } from "effect";

/**
 * Who hobs on the user's account commit as when the user's Git config sets no identity (#741). A
 * hob may never set one itself (#700), so the hub asks you once, with your GitHub account
 * recommended when one is connected, keeps your answer, and every such hob commits under it.
 */

const COMMIT_IDENTITY_KIND = "commit-identity";
const SUBJECT = { kind: COMMIT_IDENTITY_KIND, key: "user", title: "Who hobs commit as" } as const;

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
const commitIdentityQuestion = (github: QuestionOption | null, unread?: string): RaiseHubQuestion => {
  const lead = unread === undefined ? WHY : `Hobbots couldn't find a name and email in "${unread.slice(0, 200)}".`;
  return github === null
    ? {
        subject: SUBJECT,
        text: `${lead} Who should hobs commit as? Type a name and email, such as ${EXAMPLE}. Or set user.name and user.email with git config --global on the hub's computer, then answer "done".`,
      }
    : {
        subject: SUBJECT,
        text: `${lead} Who should hobs commit as? Pick one, or type a name and email, such as ${EXAMPLE}.`,
        options: [github, OWN_GIT],
        recommended: 0,
      };
};

/** Who hobs on the user's account commit as when the user's Git config sets no identity (#741). */
export class CommitIdentityGate extends Context.Service<
  CommitIdentityGate,
  {
    /**
     * The identity you gave, for a turn of `agentId` on your account, or null. While neither it nor
     * your Git config sets one, it asks you who hobs should commit as, one question at a time.
     */
    readonly forTurn: (agentId: AgentId) => Effect.Effect<CommitIdentity | null>;
  }
>()("@hobbots/server/CommitIdentityGate") {}

// How long a turn waits on GitHub to offer your account, before it asks without it.
const GITHUB_WAIT = "5 seconds";

/** The gate, reading your Git identity with `readUserIdentity`, your home's config by default. */
export const CommitIdentityGateLive = (readUserIdentity: () => GitIdentity = () => userGitIdentity(homedir())) =>
  Layer.effect(
    CommitIdentityGate,
    Effect.gen(function* () {
      const identities = yield* HubCommitIdentities;
      const questions = yield* HubQuestions;
      const asked = yield* HubQuestionRepository;
      // Your GitHub account, when the GitHub Charm is on this hub (ADR 020).
      const api = Option.getOrUndefined(yield* Effect.serviceOption(GitHubApi));

      const github = (agentId: AgentId) =>
        api === undefined
          ? Effect.succeed(null)
          : api.user(agentId).pipe(
              Effect.map(githubOption),
              Effect.timeout(GITHUB_WAIT),
              Effect.catchCause(() => Effect.succeed(null)),
            );

      const ask = (agentId: AgentId) =>
        Effect.gen(function* () {
          // Once at a time: not while you have the question, nor while the hub applies your answer.
          const open = yield* questions.listOpen;
          if (open.some((question) => question.subject.kind === COMMIT_IDENTITY_KIND)) return;
          if ((yield* asked.listUnapplied(COMMIT_IDENTITY_KIND)).length > 0) return;
          // An answer applied since the turn looked is saved before it is marked applied.
          if ((yield* identities.get) !== null) return;
          yield* questions.raise(commitIdentityQuestion(yield* github(agentId)));
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
          // again, with the same GitHub choice.
          if (readUserIdentity().email !== null) return;
          const github = question.options.find((option) => githubIdentityIn(option) !== null) ?? null;
          yield* questions.raise(commitIdentityQuestion(github, question.answer ?? ""));
        });
      const handler: HubQuestionHandler = { kind: COMMIT_IDENTITY_KIND, apply };
      yield* questions.handle(handler);

      return CommitIdentityGate.of({
        forTurn: (agentId) =>
          Effect.gen(function* () {
            const given = yield* identities.get;
            if (given !== null || readUserIdentity().email !== null) return given;
            yield* ask(agentId).pipe(
              Effect.catchCause((cause) => Effect.logWarning("Could not ask who hobs commit as", cause)),
            );
            return null;
          }),
      });
    }),
  );
