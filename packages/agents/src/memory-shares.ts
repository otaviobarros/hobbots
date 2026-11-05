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
  type MemoryPageVersion,
  type MemoryScope,
  MemoryShare,
  type MemoryShareState,
  type MemoryUnavailable,
  type MemoryVersion,
  memoryShareKeptText,
  memoryShareSendingText,
  memoryShareSharedText,
  memoryShareUndoneText,
  memoryShareWaitingText,
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
const earlierAnswer = (share: MemoryShare, input: string): HubToolAnswer => {
  if (share.input !== input) {
    return { text: "You already used this key for another save. Choose a new key for a new save.", refused: true };
  }
  switch (share.state) {
    case "sending":
      return share.through === "preset"
        ? { text: memoryShareSendingText(share.path, share.scope), refused: false }
        : { text: memoryShareWaitingText(share.path, share.scope), refused: false };
    case "waiting":
      return { text: memoryShareWaitingText(share.path, share.scope), refused: false };
    case "shared":
      return { text: memoryShareSharedText(share.path, share.scope), refused: false };
    case "kept":
      return { text: memoryShareKeptText(share.path), refused: false };
    case "undone":
      return { text: memoryShareUndoneText(share.path), refused: false };
  }
};

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** The expected state of a page whose current version is `version`, or that is not there (null). */
const expectedAt = (version: MemoryVersion | null): MemoryExpected =>
  version === null ? { _tag: "New" } : { _tag: "Version", version };

/** The versions written after `after`, oldest first; every version when `after` is null. */
const versionsAfter = (history: ReadonlyArray<MemoryPageVersion>, after: MemoryVersion | null) => {
  const at = after === null ? -1 : history.findIndex((each) => each.version === after);
  // History is newest first: what comes before `after` was written after it.
  return (at === -1 ? history : history.slice(0, at)).toReversed();
};

/**
 * What one write for a share left in memory, as the store answers. Each step reads what memory holds
 * first, so it can run again after a hub that stopped or memory that stopped answering, and finish
 * what landed without doing it twice.
 */
const shareEffects = (store: MemoryStoreShape) => {
  /** The page in the hob's own memory, written only when it is not already there as shared. */
  const keepOwn = (share: MemoryShare) =>
    Effect.gen(function* () {
      const own = yield* store.page(YOU, ownScopeOf(share), share.path);
      if (own !== null && own.markdown === share.markdown) return;
      yield* store.write(hobOf(share), ownScopeOf(share), draftOf(share), expectedAt(own?.version ?? null));
    });

  /** The version this share wrote as the hob after the one it recorded it replaces, if one landed. */
  const landed = (share: MemoryShare) =>
    Effect.map(store.history(YOU, share.scope, share.path), (history) =>
      versionsAfter(history, share.previous).find(
        (each) => each.author?._tag === "Hob" && each.author.agentId === share.agentId,
      ),
    );

  /**
   * Writes the page into the shared memory as the hob, over the version recorded before. When it
   * did not land, it waits for you again; a page changed since is a conflict.
   */
  const share = (sending: MemoryShare) =>
    Effect.gen(function* () {
      const found = yield* landed(sending);
      if (found !== undefined) return { state: "shared" as const, version: found.version };
      const version = yield* store.write(hobOf(sending), sending.scope, draftOf(sending), expectedAt(sending.previous));
      return { state: "shared" as const, version };
    });

  /**
   * Takes the share back: the page it replaced is written back, or a page it added is forgotten, as
   * you, only while the page is still the version the share wrote. Then the hob keeps the page in its
   * own memory. Run again, it finds what already landed: a page no longer at the share's version
   * that you changed or forgot since was taken back; any other change is a conflict, never undone over.
   */
  const undo = (sending: MemoryShare) =>
    Effect.gen(function* () {
      const current = yield* store.page(YOU, sending.scope, sending.path);
      if (current !== null && current.version === sending.version) {
        yield* sending.previous === null
          ? store.forget(YOU, sending.scope, sending.path, expectedAt(current.version))
          : store.restore(YOU, sending.scope, sending.path, sending.previous);
      } else if (current !== null) {
        const after = versionsAfter(yield* store.history(YOU, sending.scope, sending.path), sending.version);
        if (after.length === 0 || after[0]?.author?._tag !== "You") {
          return yield* new MemoryConflict({ path: sending.path, current: current.version });
        }
      }
      yield* keepOwn(sending);
      return { state: "undone" as const };
    });

  const keep = (sending: MemoryShare) => Effect.as(keepOwn(sending), { state: "kept" as const });

  /** Runs what `sending` records it is writing, and answers the share's fields once it landed. */
  return (sending: MemoryShare): Effect.Effect<Partial<MemoryShare>, MemoryUnavailable | MemoryConflict> => {
    switch (sending.pending) {
      case "keep":
        return keep(sending);
      case "undo":
        return undo(sending);
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
    const write = shareEffects(store);
    /** Shares being written in this process, which recovery leaves to the call writing them. */
    const writing = new Set<string>();

    /** Moves `share` to its new state from one of `from`, announced, or None when it moved on meanwhile. */
    const move = (share: MemoryShare, from: ReadonlyArray<MemoryShareState>) =>
      Effect.gen(function* () {
        const moved = yield* log.move(share, from);
        if (Option.isNone(moved)) return Option.none<MemoryShare>();
        yield* announce(moved.value.entries);
        return Option.some(moved.value.value);
      });

    const changed = (share: MemoryShare, fields: Partial<MemoryShare>) =>
      Effect.map(now, (at) => new MemoryShare({ ...share, ...fields, updatedAt: at }));

    /** Where a share that did not finish goes back to: a share or keep waits for you, an undo stays shared. */
    const back = (sending: MemoryShare) =>
      changed(
        sending,
        sending.pending === "undo"
          ? { state: "shared", pending: null }
          : { state: "waiting", pending: null, through: "review", version: null, previous: null },
      );

    /**
     * Writes what `sending` records and saves the outcome. A conflict sends it back; memory that does
     * not answer leaves it `sending` for recovery. Either way the error is answered.
     */
    const settle = (sending: MemoryShare) =>
      Effect.gen(function* () {
        const fields = yield* write(sending).pipe(
          Effect.tapError((error) =>
            error._tag === "MemoryConflict"
              ? Effect.flatMap(back(sending), (it) => move(it, ["sending"]))
              : Effect.void,
          ),
        );
        const decided = yield* changed(sending, { ...fields, pending: null, decidedAt: yield* now });
        return yield* move(decided, ["sending"]);
      }).pipe(Effect.ensuring(Effect.sync(() => writing.delete(sending.id))));

    /** Finishes every share left `sending` that no call is writing; one memory does not take stays. */
    const recover = Effect.gen(function* () {
      for (const share of yield* log.list(0)) {
        if (share.state !== "sending" || writing.has(share.id)) continue;
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
                Effect.map((page) => Option.some(page?.version ?? null)),
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
          previous: Option.getOrNull(before),
          threadId: turn.threadId,
          messageId: turn.messageId,
          createdAt: at,
          updatedAt: at,
          decidedAt: null,
        });
        const started = yield* log.begin(recorded, turn.also);
        if (started._tag === "Existing") return earlierAnswer(started.share, request.input);
        yield* announce(started.entries);
        if (recorded.state === "waiting") return earlierAnswer(recorded, request.input);
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

    /** The share `id`, when it is in `state`. */
    const open = (id: string, state: MemoryShareState) =>
      Effect.gen(function* () {
        const found = yield* log.get(id);
        if (Option.isNone(found)) return yield* new MemoryShareNotFound({ shareId: id });
        if (found.value.state !== state) {
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
     * Your decision on the share `id` while it is `from`: claims it by recording what is about to be
     * written (`sending`), so a second decision is refused and the write can be recovered, then writes
     * it. `prepare` reads what the claim must record first.
     */
    const decide = (
      id: string,
      from: MemoryShareState,
      prepare: (share: MemoryShare) => Effect.Effect<Partial<MemoryShare>, MemoryUnavailable | MemoryConflict>,
    ) =>
      answered(id)(
        Effect.gen(function* () {
          yield* UserSession;
          const current = yield* open(id, from);
          const fields = yield* prepare(current);
          // Marked before the claim lands, and until the write ends, so recovery never runs it too.
          writing.add(id);
          return yield* Effect.gen(function* () {
            const claimed = yield* move(yield* changed(current, { ...fields, state: "sending" }), [from]);
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
            decide(id, "waiting", (waiting) =>
              Effect.map(store.page(YOU, waiting.scope, waiting.path), (page) => ({
                pending: "share" as const,
                markdown: markdown ?? waiting.markdown,
                edited: markdown !== undefined && markdown !== waiting.markdown,
                previous: page?.version ?? null,
              })),
            ),
          keep: (id) => decide(id, "waiting", () => Effect.succeed({ pending: "keep" as const })),
          undo: (id) =>
            decide(id, "shared", (shared) =>
              Effect.flatMap(store.page(YOU, shared.scope, shared.path), (current) =>
                // A page changed since it was shared is yours to sort out on the page, never undone over.
                current === null || current.version !== shared.version
                  ? Effect.fail(new MemoryConflict({ path: shared.path, current: current?.version ?? null }))
                  : Effect.succeed({ pending: "undo" as const }),
              ),
            ),
        }),
      ),
    );
  }),
);
