import {
  MemoryNotAnswering,
  MemoryShareChangedMeanwhile,
  MemoryShareClosed,
  MemoryShareNotFound,
  UserSession,
} from "@hobbots/api";
import {
  type Committed,
  type EventEnvelope,
  type MemoryActor,
  MemoryConflict,
  type MemoryDraft,
  type MemoryExpected,
  type MemoryPage,
  type MemoryScope,
  MemoryShare,
  type MemoryShareEvent,
  type MemoryShareState,
  MemoryShareStates,
  MemoryUnavailable,
  type MemoryVersion,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Schedule } from "effect";
import { type MemoryShareRequest, MemoryShares, MemoryStore, type MemoryStoreShape } from "./memory.ts";
import { announcer, EventPublisher } from "./ports.ts";
import type { HubToolAnswer } from "./runtime.ts";

/**
 * Sharing (ADR 028): the hub's rules for a share a hob asks for with `memory_save`, and your
 * decisions on it. Hobs never write a shared scope themselves. Under Careful and Balanced a share
 * waits for your review; under Trusting a share to a project goes through, and shows in What changed
 * with Undo; a share with every hob (About you) waits under every preset. A share is recorded and
 * journaled before anything is written, so a retried key returns the first answer. Once you share it,
 * the hub writes the page as the hob that asked, and the record names you as the one who approved it.
 */

/** What recording a share found: it is new, and journaled, or the hob used its key before in the same work. */
export type MemoryShareStart =
  | { readonly _tag: "Started"; readonly entries: ReadonlyArray<EventEnvelope> }
  | { readonly _tag: "Existing"; readonly share: MemoryShare };

/** The record of every share a hob asked for, kept by the hub's database. */
export class MemoryShareLog extends Context.Service<
  MemoryShareLog,
  {
    /**
     * Records `share` and journals it, unless the hob's key is already taken in the same work or in
     * `also`: that share is returned instead, and nothing is written.
     */
    readonly begin: (share: MemoryShare, also?: string) => Effect.Effect<MemoryShareStart>;
    /**
     * Saves `share` as it now stands, and journals it, when its record is still in one of `from`.
     * None when it moved on meanwhile, so of two decisions racing for one share only the first lands.
     */
    readonly move: (
      share: MemoryShare,
      from: ReadonlyArray<MemoryShareState>,
    ) => Effect.Effect<Option.Option<Committed<MemoryShare>>>;
    readonly get: (id: string) => Effect.Effect<Option.Option<MemoryShare>>;
    /** Every share that waits or is being written, oldest first, then the latest `decided` others, newest first. */
    readonly list: (decided: number) => Effect.Effect<ReadonlyArray<MemoryShare>>;
  }
>()("@hobbots/agents/MemoryShareLog") {}

/** Errors a decision on a share answers with. */
export type MemoryShareDecisionError =
  | MemoryShareNotFound
  | MemoryShareClosed
  | MemoryShareChangedMeanwhile
  | MemoryNotAnswering;

/**
 * Your side of sharing: what waits for you and what was decided lately, and your decisions. Only you
 * decide: each decision needs a `UserSession`, which no hob, Charm or runtime tool has (PE-006).
 */
export class MemoryReviews extends Context.Service<
  MemoryReviews,
  {
    readonly list: Effect.Effect<ReadonlyArray<MemoryShare>>;
    /**
     * Finishes every write for a share that a stopped hub or an outage cut short, as far as memory
     * answers: what landed is recorded, and what did not is written or sent back. The hub runs it at
     * start and every 30 seconds.
     */
    readonly recover: Effect.Effect<void>;
    /** Shares the page, as the hob wrote it or as you edited it (`markdown`). */
    readonly share: (
      id: string,
      markdown: string | undefined,
    ) => Effect.Effect<MemoryShare, MemoryShareDecisionError, UserSession>;
    /** Keeps the page private: it goes to the hob's own memory instead. */
    readonly keep: (id: string) => Effect.Effect<MemoryShare, MemoryShareDecisionError, UserSession>;
    /** Takes a share back: the shared page is as it was before, and the hob keeps the page itself. */
    readonly undo: (id: string) => Effect.Effect<MemoryShare, MemoryShareDecisionError, UserSession>;
  }
>()("@hobbots/agents/MemoryReviews") {}

/** How many decided shares the list keeps after those that wait. */
const DECIDED_SHOWN = 50;

const YOU: MemoryActor = { _tag: "You" };

/** The hob a share is written as: it reaches the project the share is for, and everyone's. */
const hobOf = (share: MemoryShare): MemoryActor => ({
  _tag: "Hob",
  agentId: share.agentId,
  projects: share.scope._tag === "Project" ? [share.scope.identity] : [],
});

const ownScopeOf = (share: MemoryShare): MemoryScope => ({ _tag: "Hob", agentId: share.agentId });

const draftOf = (share: MemoryShare, markdown: string = share.markdown): MemoryDraft => ({
  path: share.path,
  markdown,
  tags: share.tags,
  pinned: false,
});

/** What a hob is told about a share it asked for before, by where that share stands. */
const earlierAnswer = (share: MemoryShare, input: string): HubToolAnswer =>
  share.input === input
    ? { text: MemoryShareStates.answerText(share), refused: false }
    : { text: "You already used this key for another save. Choose a new key for a new save.", refused: true };

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** The expected state of a page whose current version is `version`, or that is not there (null). */
const expectedAt = (version: MemoryVersion | null): MemoryExpected =>
  version === null ? { _tag: "New" } : { _tag: "Version", version };

/** Records an Undo's first step as landed, before its last step runs. */
type Step = (sending: MemoryShare) => Effect.Effect<MemoryShare>;

/** What landed in memory for a share, as the event that records it, without its time. */
type Landed =
  | { readonly _tag: "Shared"; readonly version: MemoryVersion }
  | { readonly _tag: "Kept" }
  | { readonly _tag: "Undone" };

/** What a write for a share landed, and the share as it stood once it did: an Undo records a step on the way. */
interface Written {
  readonly landed: Landed;
  readonly share: MemoryShare;
}

/** The share after `event`. A refused event here is a bug: callers check the state first. */
const transitioned = (share: MemoryShare, event: MemoryShareEvent) => {
  const next = MemoryShareStates.transition(share, event);
  return next instanceof MemoryShare ? Effect.succeed(next) : Effect.die(next);
};

/**
 * What one write for a share left in memory, as the store answers. Each step reads what memory holds
 * first, so it can run again after a hub that stopped or memory that stopped answering, and finish
 * what landed without doing it twice. A write of the hub's own is known in the page's history by
 * what it changed against the version it replaced, never by who memory says wrote it: memory names
 * no author for an older version.
 */
const shareEffects = (store: MemoryStoreShape, step: Step) => {
  /** The page in the hob's own memory, written only when it is not already there as shared. */
  const keepOwn = (share: MemoryShare) =>
    Effect.gen(function* () {
      const own = yield* store.page(YOU, ownScopeOf(share), share.path);
      if (own !== null && own.markdown === share.markdown) return;
      yield* store.write(hobOf(share), ownScopeOf(share), draftOf(share), expectedAt(own?.version ?? null));
    });

  /**
   * The version that replaced `after` (null for none: the page's first version) in the shared page,
   * when it holds exactly `to`; undefined when another change replaced it, or none did. What that
   * version holds is read whole, never guessed from part of a diff: memory that cannot answer it
   * whole leaves the share as it is, for recovery to look again.
   */
  const replacedBy = (
    share: MemoryShare,
    current: MemoryPage | null,
    after: { readonly version: MemoryVersion; readonly markdown: string } | null,
    to: string,
  ) =>
    Effect.gen(function* () {
      const history = yield* store.history(YOU, share.scope, share.path);
      const next = history.find((each) => each.supersedes === (after?.version ?? null));
      const known = after ?? current;
      if (next === undefined || known === null) return undefined;
      const text =
        next.latest && current !== null
          ? current.markdown
          : yield* store.versionText(YOU, share.scope, share.path, next.version, known);
      if (text === null) {
        return yield* new MemoryUnavailable({ message: "Memory did not answer a version of the page whole." });
      }
      return text === to ? next.version : undefined;
    });

  /**
   * Writes the page into the shared memory as the hob, only over the version recorded before. A
   * page that moved on since holds this share when the version that replaced it made this share's
   * change; any other change is a conflict, and the share waits for you again.
   */
  const share = (sending: MemoryShare) =>
    Effect.gen(function* () {
      const current = yield* store.page(YOU, sending.scope, sending.path);
      if ((current?.version ?? null) === sending.previous) {
        const version = yield* store.write(
          hobOf(sending),
          sending.scope,
          draftOf(sending),
          expectedAt(sending.previous),
        );
        return { landed: { _tag: "Shared", version }, share: sending } satisfies Written;
      }
      const before =
        sending.previous === null || sending.replaced === null
          ? null
          : { version: sending.previous, markdown: sending.replaced };
      const landed =
        sending.previous !== null && before === null
          ? undefined
          : yield* replacedBy(sending, current, before, sending.markdown);
      if (landed === undefined) {
        return yield* new MemoryConflict({ path: sending.path, current: current?.version ?? null });
      }
      return { landed: { _tag: "Shared", version: landed }, share: sending } satisfies Written;
    });

  /** Whether the shared memory is already back as it was before the share: this Undo's first step landed. */
  const takenBack = (sending: MemoryShare, current: MemoryPage | null) =>
    Effect.gen(function* () {
      if (sending.previous === null) {
        // A forget: the page is gone, or a page started again after it, which replaces nothing.
        if (current === null) return true;
        const history = yield* store.history(YOU, sending.scope, sending.path);
        return !history.some((each) => each.supersedes === sending.version);
      }
      if (sending.version === null) return false;
      const back = yield* replacedBy(
        sending,
        current,
        { version: sending.version, markdown: sending.markdown },
        sending.replaced ?? "",
      );
      return back !== undefined;
    });

  /** Undo's last step: the hob keeps the page in its own memory. */
  const keepOwnUndone = (restored: MemoryShare) =>
    Effect.as(keepOwn(restored), { landed: { _tag: "Undone" }, share: restored } satisfies Written);

  /**
   * Takes the share back: the page it replaced is written back, or a page it added is forgotten, as
   * you, only while the page is still the version the share wrote. That step is recorded before the
   * hob keeps the page in its own memory, so a later change to the page never strands an Undo half
   * done. Run again, it finds its own restore in the history; any other change is a conflict, never
   * undone over.
   */
  const undo = (sending: MemoryShare) =>
    Effect.gen(function* () {
      const current = yield* store.page(YOU, sending.scope, sending.path);
      if (current !== null && current.version === sending.version) {
        const still = expectedAt(sending.version);
        yield* sending.previous === null
          ? store.forget(YOU, sending.scope, sending.path, still)
          : store.restore(YOU, sending.scope, sending.path, sending.previous, still);
      } else if (!(yield* takenBack(sending, current))) {
        return yield* new MemoryConflict({ path: sending.path, current: current?.version ?? null });
      }
      return yield* keepOwnUndone(yield* step(sending));
    });

  const keep = (sending: MemoryShare) =>
    Effect.as(keepOwn(sending), { landed: { _tag: "Kept" }, share: sending } satisfies Written);

  /** Runs what `sending` records it is writing, and answers what landed. */
  return (sending: MemoryShare): Effect.Effect<Written, MemoryUnavailable | MemoryConflict> => {
    switch (sending.pending) {
      case "keep":
        return keep(sending);
      case "undo":
        return undo(sending);
      case "restored":
        return keepOwnUndone(sending);
      default:
        return share(sending);
    }
  };
};

/**
 * `MemoryShares` for the hob's tools and `MemoryReviews` for you, over one store and one log. Before
 * the hub writes anything for a share, it records what it is about to write (`pending`) and the
 * version it replaces, so a write that a stopped hub or an outage cut short is finished, or undone,
 * once memory answers: at start, then every 30 seconds while any is left.
 */
export const MemorySharesLive = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* MemoryStore;
    const log = yield* MemoryShareLog;
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a memory share");
    /**
     * Shares being written in this process, which recovery leaves to the call writing them. A lock,
     * not a lifecycle: where a share stands is its record's state (`MemoryShareMachine`), and this
     * only keeps a call and recovery from writing the same share at once.
     */
    const writing = new Set<string>();

    /**
     * Moves `share` on by `event` (MemoryShareMachine), saved only while its record is still in the
     * state it was read in, and announced; None when it moved on meanwhile.
     */
    const move = (share: MemoryShare, event: (at: string) => MemoryShareEvent) =>
      Effect.flatMap(
        Effect.flatMap(now, (at) => transitioned(share, event(at))),
        (next) => saved(share, next),
      );

    /** Saves `next` while the record is still in the state `share` was read in, announced. */
    const saved = (share: MemoryShare, next: MemoryShare) =>
      Effect.gen(function* () {
        const moved = yield* log.move(next, [MemoryShareStates.stateOf(share)]);
        if (Option.isNone(moved)) return Option.none<MemoryShare>();
        yield* announce(moved.value.entries);
        return Option.some(moved.value.value);
      });

    /** Records that an Undo's first step landed, before its last step runs. */
    const step: Step = (sending) =>
      Effect.gen(function* () {
        const restored = yield* transitioned(sending, { _tag: "Restored", at: yield* now });
        return Option.getOrElse(yield* saved(sending, restored), () => restored);
      });
    const write = shareEffects(store, step);

    /**
     * Sends the share `id` back after a conflict, by the step it is at now: a step the write recorded
     * meanwhile counts. A share or keep waits for you again, an Undo stays shared. Past Undo's first
     * step the shared memory is back as it was, so only the hob's own copy is left: the machine keeps
     * that one `sending`, for recovery to write it again.
     */
    const sendBack = (id: string) =>
      Effect.flatMap(log.get(id), (found) => {
        const conflicted = (at: string): MemoryShareEvent => ({ _tag: "Conflicted", at });
        return Option.isSome(found) && MemoryShareStates.can(found.value, conflicted(found.value.updatedAt))
          ? move(found.value, conflicted)
          : Effect.void;
      });

    /**
     * Writes what `sending` records and saves the outcome. A conflict sends it back; memory that does
     * not answer leaves it `sending` for recovery. Either way the error is answered.
     */
    const settle = (sending: MemoryShare) =>
      Effect.gen(function* () {
        const written = yield* write(sending).pipe(
          Effect.tapError((error) => (error._tag === "MemoryConflict" ? sendBack(sending.id) : Effect.void)),
        );
        return yield* move(written.share, (at) => ({ ...written.landed, at }));
      }).pipe(Effect.ensuring(Effect.sync(() => writing.delete(sending.id))));

    /** Finishes every share left `sending` that no call is writing; one memory does not take stays. */
    const recover = Effect.gen(function* () {
      for (const share of yield* log.list(0)) {
        if (!MemoryShareStates.isSending(share) || writing.has(share.id)) continue;
        writing.add(share.id);
        yield* settle(share).pipe(
          Effect.catchTag("MemoryUnavailable", () => Effect.void),
          Effect.catchTag("MemoryConflict", () => Effect.void),
        );
      }
    });
    yield* recover.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);

    const share = (request: MemoryShareRequest) =>
      Effect.gen(function* () {
        const { turn, scope, draft } = request;
        // Trusting lets a share to a project through, over the page as it is now. Memory that does
        // not answer leaves it to you.
        const before =
          request.preset === "trusting" && scope._tag === "Project"
            ? yield* store.page(YOU, scope, draft.path).pipe(
                Effect.map((page) => Option.some(page)),
                Effect.catchTag("MemoryUnavailable", () => Effect.succeed(Option.none())),
              )
            : Option.none();
        const at = yield* now;
        const recorded = new MemoryShare({
          id: crypto.randomUUID(),
          agentId: turn.agentId,
          work: turn.scope(),
          key: request.key,
          input: request.input,
          scope,
          path: draft.path,
          markdown: draft.markdown,
          tags: draft.tags,
          state: Option.isSome(before) ? "sending" : "waiting",
          pending: Option.isSome(before) ? "share" : null,
          through: Option.isSome(before) ? "preset" : "review",
          edited: false,
          version: null,
          previous: Option.match(before, { onNone: () => null, onSome: (page) => page?.version ?? null }),
          replaced: Option.match(before, { onNone: () => null, onSome: (page) => page?.markdown ?? null }),
          threadId: turn.threadId,
          messageId: turn.messageId,
          createdAt: at,
          updatedAt: at,
          decidedAt: null,
        });
        const started = yield* log.begin(recorded, turn.also);
        if (started._tag === "Existing") return earlierAnswer(started.share, request.input);
        yield* announce(started.entries);
        if (MemoryShareStates.waits(recorded)) return earlierAnswer(recorded, request.input);
        writing.add(recorded.id);
        const settled = yield* settle(recorded).pipe(
          Effect.catchTag("MemoryConflict", () => Effect.succeedNone),
          // Left for recovery, which shares it once memory answers: the hob is told it is under way.
          Effect.catchTag("MemoryUnavailable", () => Effect.succeedNone),
        );
        return earlierAnswer(
          Option.getOrElse(settled, () => recorded),
          request.input,
        );
      });

    /** The share `id`, when `takes` says it takes the decision. */
    const open = (id: string, takes: (share: MemoryShare) => boolean) =>
      Effect.gen(function* () {
        const found = yield* log.get(id);
        if (Option.isNone(found)) return yield* new MemoryShareNotFound({ shareId: id });
        if (!takes(found.value)) {
          return yield* new MemoryShareClosed({ shareId: id, state: found.value.state });
        }
        return found.value;
      });

    /** The share moved on while a decision was under way: it is closed, as it now stands. */
    const closedNow = (id: string) =>
      Effect.flatMap(log.get(id), (current) =>
        Effect.fail(
          Option.isSome(current)
            ? new MemoryShareClosed({ shareId: id, state: current.value.state })
            : new MemoryShareNotFound({ shareId: id }),
        ),
      );

    /** Memory's own errors, as a decision answers them. */
    const answered =
      (id: string) =>
      <A, R>(effect: Effect.Effect<A, MemoryUnavailable | MemoryConflict | MemoryShareDecisionError, R>) =>
        effect.pipe(
          Effect.catchTags({
            MemoryUnavailable: () => Effect.fail(new MemoryNotAnswering()),
            MemoryConflict: () => Effect.fail(new MemoryShareChangedMeanwhile({ shareId: id })),
          }),
        );

    /**
     * Your decision on the share `id`, when `takes` says it takes one: claims it by recording what is
     * about to be written (`sending`), so a second decision is refused and the write can be recovered,
     * then writes it. `prepare` reads what the claim must record first, and gives the decision's event.
     */
    const decide = (
      id: string,
      takes: (share: MemoryShare) => boolean,
      prepare: (
        share: MemoryShare,
      ) => Effect.Effect<(at: string) => MemoryShareEvent, MemoryUnavailable | MemoryConflict>,
    ) =>
      answered(id)(
        Effect.gen(function* () {
          yield* UserSession;
          const current = yield* open(id, takes);
          const event = yield* prepare(current);
          // Marked before the claim lands, and until the write ends, so recovery never runs it too.
          writing.add(id);
          return yield* Effect.gen(function* () {
            const claimed = yield* move(current, event);
            if (Option.isNone(claimed)) return yield* closedNow(id);
            const settled = yield* settle(claimed.value);
            return Option.isSome(settled) ? settled.value : yield* closedNow(id);
          }).pipe(Effect.ensuring(Effect.sync(() => writing.delete(id))));
        }),
      );

    return Context.make(MemoryShares, MemoryShares.of({ share })).pipe(
      Context.add(
        MemoryReviews,
        MemoryReviews.of({
          list: log.list(DECIDED_SHOWN),
          recover,
          share: (id, markdown) =>
            decide(id, MemoryShareStates.waits, (waiting) =>
              Effect.map(
                store.page(YOU, waiting.scope, waiting.path),
                (page) =>
                  (at: string): MemoryShareEvent => ({
                    _tag: "Share",
                    markdown: markdown ?? waiting.markdown,
                    edited: markdown !== undefined && markdown !== waiting.markdown,
                    previous: page?.version ?? null,
                    replaced: page?.markdown ?? null,
                    at,
                  }),
              ),
            ),
          keep: (id) =>
            decide(id, MemoryShareStates.waits, () =>
              Effect.succeed((at: string): MemoryShareEvent => ({ _tag: "Keep", at })),
            ),
          undo: (id) =>
            decide(id, MemoryShareStates.isShared, (shared) =>
              Effect.flatMap(store.page(YOU, shared.scope, shared.path), (current) =>
                // A page changed since it was shared is yours to sort out on the page, never undone over.
                current === null || current.version !== shared.version
                  ? Effect.fail(new MemoryConflict({ path: shared.path, current: current?.version ?? null }))
                  : Effect.succeed((at: string): MemoryShareEvent => ({ _tag: "Undo", at })),
              ),
            ),
        }),
      ),
    );
  }),
);
