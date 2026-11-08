import {
  AgentId,
  CODING_SETUP_KIND,
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
import { CodingSetupDismissals, HubCommitIdentities } from "./ports.ts";

/**
 * Who hobs on the user's account commit as when the user's Git config sets no identity (#741). A
 * hob may never set one itself (#700). With the hub's GitHub account connected, hobs commit as it
 * without asking. Otherwise the hub asks, once per hob and in plain words, whether the hob will
 * write code, and leads you to its GitHub section (#1241). You can say not for this hob, or not for
 * any hob, and clear both in Settings.
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

/** The dismissal that covers every hob. */
export const ALL_HOBS = "*";

/** The choice that stops the card for every hob. */
export const ANY_HOB_LABEL = "Don't ask for any hob";

/** A hob as the card names it. */
export interface CodingHob {
  readonly id: AgentId;
  readonly name: string;
}

const short = (name: string) => (name.length > 40 ? `${name.slice(0, 39)}…` : name);

/** The choice that stops the card for one hob. */
export const notForLabel = (hob: Pick<CodingHob, "name">) => `Not for ${short(hob.name)}`;

const choices = (hob: CodingHob): ReadonlyArray<QuestionOption> => [
  { label: notForLabel(hob), consequence: `Hobbots won't ask about ${short(hob.name)} again.` },
  {
    label: ANY_HOB_LABEL,
    consequence: "Hobbots won't ask about any hob. You can turn it back on in Settings › Connections › Charms.",
  },
];

/** The card: whether the hob will write code, and why it would need GitHub, in plain words. */
const codingSetupQuestion = (hob: CodingHob, chat: HubQuestionChat | null): RaiseHubQuestion => {
  const name = short(hob.name);
  return {
    subject: { kind: CODING_SETUP_KIND, key: hob.id, title: `Coding setup for ${name}` },
    ...(chat === null ? {} : { chat }),
    text: [
      `Will ${name} write code?`,
      `If ${name} will work on code, link a GitHub account so its changes are saved under a name. It takes a minute in the GitHub section of ${name}'s profile.`,
      `If ${name} is just for writing, research or chatting, you don't need this.`,
    ].join("\n\n"),
    options: [...choices(hob)],
  };
};

// Before #1241 the hub asked who hobs commit as, in words. An answer it has not applied yet is
// still kept; an open one is withdrawn, since the coding setup card replaces it.
const LEGACY_KIND = "commit-identity";
const GITHUB_PREFIX = "Commits are made as ";
const GITHUB_SUFFIX = ", which GitHub links to your account.";
const legacyIdentity = (question: HubQuestion): CommitIdentity | null => {
  const picked = question.picked === null ? undefined : question.options[question.picked];
  if (picked?.consequence.startsWith(GITHUB_PREFIX) && picked.consequence.endsWith(GITHUB_SUFFIX))
    return parseCommitIdentity(picked.consequence.slice(GITHUB_PREFIX.length, -GITHUB_SUFFIX.length));
  return question.picked === null ? parseCommitIdentity(question.answer ?? "") : null;
};

/** A turn about to start, and the chat a question about it concerns. */
export interface TurnStart {
  readonly chat: HubQuestionChat | null;
}

export class CommitIdentityQuestions extends Context.Service<
  CommitIdentityQuestions,
  {
    /**
     * Who a turn of `hob`, a hob on your account, commits as: as your Git config sets you, as you
     * told the hub, as the hub's GitHub account, or no one yet. For a turn about to start that may
     * commit (`turn`) while none applies, it asks whether the hob will write code, unless you said
     * not to. Reading access at any other time asks nothing.
     */
    readonly forTurn: (hob: CodingHob, turn?: TurnStart) => Effect.Effect<CommitsAs>;
    /** The hob commits as its own GitHub App now: its card is no longer needed. */
    readonly settled: (agentId: AgentId) => Effect.Effect<void>;
    /** Where you said not to ask. */
    readonly dismissed: Effect.Effect<{ readonly allHobs: boolean; readonly hobs: ReadonlyArray<AgentId> }>;
    /** Forgets where you said not to ask, so every hob may be asked again. */
    readonly clearDismissed: Effect.Effect<void>;
  }
>()("@hobbots/agents/CommitIdentityQuestions") {
  static readonly layer = Layer.effect(
    CommitIdentityQuestions,
    Effect.gen(function* () {
      const identities = yield* HubCommitIdentities;
      const dismissals = yield* CodingSetupDismissals;
      const questions = yield* HubQuestions;
      const asked = yield* HubQuestionRepository;
      const git = yield* UserGitIdentity;
      const github = Option.getOrUndefined(yield* Effect.serviceOption(ConnectedGitHubUser));
      // Whether to ask is decided and the question raised under one permit, so two turns never both ask.
      const deciding = yield* Semaphore.make(1);

      const openCards = (key?: string) =>
        questions.listOpen.pipe(
          Effect.map((open) =>
            open.filter(
              (question) =>
                question.subject.kind === CODING_SETUP_KIND && (key === undefined || question.subject.key === key),
            ),
          ),
        );
      const withdrawCards = (key?: string) =>
        Effect.flatMap(openCards(key), (open) => Effect.forEach(open, (question) => questions.withdraw(question.id)));

      /** Whether this hob's card is open or its answer waits to be applied, or you said not to ask. */
      const quiet = (hob: CodingHob) =>
        Effect.gen(function* () {
          if ((yield* openCards(hob.id)).length > 0) return true;
          const unapplied = yield* asked.listUnapplied(CODING_SETUP_KIND);
          if (unapplied.some((question) => question.subject.key === hob.id)) return true;
          const said = yield* dismissals.list;
          return said.includes(ALL_HOBS) || said.includes(hob.id);
        });

      const ask = (hob: CodingHob, chat: HubQuestionChat | null) =>
        Semaphore.withPermit(
          deciding,
          Effect.gen(function* () {
            if (yield* quiet(hob)) return;
            // An identity saved meanwhile, by another turn or in Git, needs no card.
            if ((yield* identities.get) !== null || (yield* git.read).email !== null) return;
            yield* questions.raise(codingSetupQuestion(hob, chat));
          }),
        );

      /** Commits as the hub's GitHub account when one is connected, keeping it; null when none is. */
      // A read that found no account is trusted for a minute, so a hub without one, or offline, does
      // not hold every turn on GitHub.
      let noGitHubUntil = 0;
      const useGitHub = (hob: CodingHob) =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (github === undefined || now < noGitHubUntil) return null;
          const user = yield* github.get(hob.id);
          if (user === null) {
            noGitHubUntil = now + 60_000;
            return null;
          }
          const identity = githubUserCommitIdentity(user);
          yield* identities.save(identity, DateTime.formatIso(yield* DateTime.now));
          yield* withdrawCards();
          return identity;
        });

      // Under the same permit as asking, so a card is never raised after you said not to ask.
      const apply = (question: HubQuestion) =>
        Semaphore.withPermit(
          deciding,
          Effect.gen(function* () {
            const at = DateTime.formatIso(yield* DateTime.now);
            // The choices are in a fixed order: this hob, then every hob. Anything typed changes nothing.
            if (question.picked === 0) yield* dismissals.dismiss(question.subject.key, at);
            if (question.picked === 1) {
              yield* dismissals.dismiss(ALL_HOBS, at);
              yield* withdrawCards();
            }
          }),
        );
      yield* questions.handle({ kind: CODING_SETUP_KIND, apply } satisfies HubQuestionHandler);

      const applyLegacy = (question: HubQuestion) =>
        Effect.gen(function* () {
          const identity = legacyIdentity(question);
          if (identity !== null) yield* identities.save(identity, DateTime.formatIso(yield* DateTime.now));
        });
      yield* questions.handle({ kind: LEGACY_KIND, apply: applyLegacy });
      const legacyOpen = (yield* questions.listOpen).filter((question) => question.subject.kind === LEGACY_KIND);
      yield* Effect.forEach(legacyOpen, (question) => questions.withdraw(question.id));

      return CommitIdentityQuestions.of({
        forTurn: (hob, turn) =>
          Effect.gen(function* () {
            const config = yield* git.read;
            const given = yield* identities.get;
            if (turn === undefined || given !== null || config.email !== null)
              return settleCommitsAs(null, config, given);
            const fromGitHub = yield* useGitHub(hob).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not use the GitHub account for commits", cause).pipe(Effect.as(null)),
              ),
            );
            if (fromGitHub !== null) return settleCommitsAs(null, config, fromGitHub);
            yield* ask(hob, turn.chat).pipe(
              Effect.catchCause((cause) => Effect.logWarning("Could not ask whether the hob will write code", cause)),
            );
            return settleCommitsAs(null, config, null);
          }),
        settled: (agentId) => withdrawCards(agentId).pipe(Effect.asVoid),
        dismissed: Effect.map(dismissals.list, (said) => ({
          allHobs: said.includes(ALL_HOBS),
          hobs: said.filter((scope) => scope !== ALL_HOBS).map((scope) => AgentId.make(scope)),
        })),
        clearDismissed: dismissals.clear,
      });
    }),
  );
}
