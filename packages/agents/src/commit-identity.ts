import {
  AgentId,
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
import { CodingSetupDismissals, HobGitHubApps, HubCommitIdentities } from "./ports.ts";

/**
 * Who hobs on the user's account commit as when the user's Git config sets no identity (#741). A
 * hob may never set one itself (#700). With the hub's GitHub account connected, hobs commit as it
 * without asking. Otherwise the hub asks, once per hob, whether the hob will write code, and leads
 * you to its GitHub section (#1241). You can say not for this hob, or not for any hob, and clear
 * both in Settings.
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

const KIND = "coding-setup";

/** A hob as the card names it. */
export interface CodingHob {
  readonly id: AgentId;
  readonly name: string;
}

/** The card: whether the hob will write code. The client words it (#1045). */
const codingSetupQuestion = (hob: CodingHob, chat: HubQuestionChat | null): RaiseHubQuestion => ({
  key: hob.id,
  ...(chat === null ? {} : { chat }),
  ask: { kind: KIND, hob: hob.name.trim().slice(0, 200) || hob.id },
  options: ["not-this-hob", "no-hob"],
});

// Before #1241 the hub asked who hobs commit as, in words (#741). An answer it has not applied yet
// is still kept; an open question is withdrawn, since the coding setup card replaces it (#1244).
const LEGACY_KIND = "commit-identity";
const legacyIdentity = (question: HubQuestion) => {
  if (question.ask.kind !== LEGACY_KIND) return null;
  if (question.picked === "github") return question.ask.github?.identity ?? null;
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
      const apps = Option.getOrUndefined(yield* Effect.serviceOption(HobGitHubApps));
      // Raising a card, settling one and applying an answer all happen under one permit, so a card is
      // never raised after its hob got its own app or you said not to ask, and two turns never both ask.
      const deciding = yield* Semaphore.make(1);

      const openCards = (key?: string) =>
        questions.listOpen.pipe(
          Effect.map((open) =>
            open.filter((question) => question.ask.kind === KIND && (key === undefined || question.key === key)),
          ),
        );
      const withdrawCards = (key?: string) =>
        Effect.flatMap(openCards(key), (open) => Effect.forEach(open, (question) => questions.withdraw(question.id)));

      /** Whether this hob's card is open or its answer waits to be applied, or you said not to ask. */
      const quiet = (hob: CodingHob) =>
        Effect.gen(function* () {
          if ((yield* openCards(hob.id)).length > 0) return true;
          const unapplied = yield* asked.listUnapplied(KIND);
          if (unapplied.some((question) => question.key === hob.id)) return true;
          const said = yield* dismissals.list;
          return said.includes(ALL_HOBS) || said.includes(hob.id);
        });

      /** Whether the hob needs no card: an identity was saved, Git sets one, or it has its own app now. */
      const settledMeanwhile = (hob: CodingHob) =>
        Effect.gen(function* () {
          if ((yield* identities.get) !== null || (yield* git.read).email !== null) return true;
          return apps !== undefined && (yield* apps.get(hob.id)) !== null;
        });

      const ask = (hob: CodingHob, chat: HubQuestionChat | null) =>
        Semaphore.withPermit(
          deciding,
          Effect.gen(function* () {
            if ((yield* quiet(hob)) || (yield* settledMeanwhile(hob))) return;
            yield* questions.raise(codingSetupQuestion(hob, chat));
          }),
        );

      /**
       * Commits as the hub's GitHub account when one is connected, keeping it; null when none is. It
       * asks GitHub each time, so an account connected a moment ago is used at once.
       */
      const useGitHub = (hob: CodingHob) =>
        Effect.gen(function* () {
          const user = github === undefined ? null : yield* github.get(hob.id);
          if (user === null) return null;
          const identity = githubUserCommitIdentity(user);
          yield* identities.save(identity, DateTime.formatIso(yield* DateTime.now));
          yield* Semaphore.withPermit(deciding, withdrawCards());
          return identity;
        });

      const apply = (question: HubQuestion) =>
        Semaphore.withPermit(
          deciding,
          Effect.gen(function* () {
            const at = DateTime.formatIso(yield* DateTime.now);
            // A choice is applied by its key (#1045). Anything typed changes nothing.
            if (question.picked === "not-this-hob") yield* dismissals.dismiss(question.key, at);
            if (question.picked === "no-hob") {
              yield* dismissals.dismiss(ALL_HOBS, at);
              yield* withdrawCards();
            }
          }),
        );
      yield* questions.handle({ kind: KIND, apply } satisfies HubQuestionHandler);

      const applyLegacy = (question: HubQuestion) =>
        Effect.gen(function* () {
          const identity = legacyIdentity(question);
          if (identity !== null) yield* identities.save(identity, DateTime.formatIso(yield* DateTime.now));
        });
      yield* questions.handle({ kind: LEGACY_KIND, apply: applyLegacy });
      const legacyOpen = (yield* questions.listOpen).filter((question) => question.ask.kind === LEGACY_KIND);
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
        settled: (agentId) => Semaphore.withPermit(deciding, withdrawCards(agentId)).pipe(Effect.asVoid),
        dismissed: Effect.map(dismissals.list, (said) => ({
          allHobs: said.includes(ALL_HOBS),
          hobs: said.filter((scope) => scope !== ALL_HOBS).map((scope) => AgentId.make(scope)),
        })),
        clearDismissed: dismissals.clear,
      });
    }),
  );
}
