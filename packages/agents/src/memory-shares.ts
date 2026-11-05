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
  MemoryShare,
  type MemoryShareState,
  type MemoryScope,
  type MemoryUnavailable,
  type MemoryVersion,
  memoryShareKeptText,
  memoryShareSharedText,
  memoryShareUndoneText,
  memoryShareWaitingText,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { type MemoryShareRequest, MemoryShares, MemoryStore, type MemoryStoreShape } from "./memory.ts";
import { EventPublisher } from "./ports.ts";
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

/**
 * Writes the share's page into its shared memory as the hob, over the version read just before, and
 * answers the version written and the one it replaced. A page changed between the two is a conflict.
 */
const writeShared = (store: MemoryStoreShape, share: MemoryShare, draft: MemoryDraft) =>
  Effect.gen(function* () {
    const actor = hobOf(share);
    const before = yield* store.page(actor, share.scope, share.path);
    const version = yield* store.write(
      actor,
      share.scope,
      draft,
      before === null ? { _tag: "New" } : { _tag: "Version", version: before.version },
    );
    return { version, previous: before?.version ?? null };
  });

/** What a hob is told about a share it asked for before, by where that share stands. */
const earlierAnswer = (share: MemoryShare, input: string): HubToolAnswer => {
  if (share.input !== input) {
    return { text: "You already used this key for another save. Choose a new key for a new save.", refused: true };
  }
  switch (share.state) {
    case "sending":
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

/**
 * `MemoryShares` for the hob's tools and `MemoryReviews` for you, over one store and one log. At
 * start, a share a stopped hub left being written waits for you again, so none is lost.
 */
export const MemorySharesLive = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* MemoryStore;
    const log = yield* MemoryShareLog;
    const publisher = yield* Effect.serviceOption(EventPublisher);

    const announce = (entries: ReadonlyArray<EventEnvelope>) =>
      Option.isNone(publisher) || entries.length === 0
        ? Effect.void
        : publisher.value
            .publish(entries)
            .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not announce a memory share", cause)));

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

    // A share left being written by a hub that stopped waits for you again.
    for (const share of yield* log.list(0)) {
      if (share.state !== "sending") continue;
      yield* move(yield* changed(share, { state: "waiting", through: "review" }), ["sending"]);
    }

    const share = (request: MemoryShareRequest) =>
      Effect.gen(function* () {
        const { turn, scope, draft } = request;
        const through = request.preset === "trusting" && scope._tag === "Project" ? "preset" : "review";
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
          state: through === "preset" ? "sending" : "waiting",
          through,
          edited: false,
          version: null,
          previous: null,
          threadId: turn.threadId,
          messageId: turn.messageId,
          createdAt: at,
          updatedAt: at,
          decidedAt: null,
        });
        const started = yield* log.begin(recorded, turn.also);
        if (started._tag === "Existing") return earlierAnswer(started.share, request.input);
        yield* announce(started.entries);
        if (through === "review") return earlierAnswer(recorded, request.input);
        // Trusting lets a share to a project through. Memory that does not take it leaves it to you.
        const written = yield* writeShared(store, recorded, draft).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            MemoryUnavailable: () => Effect.succeed(Option.none()),
            MemoryConflict: () => Effect.succeed(Option.none()),
          }),
        );
        const settled = Option.isSome(written)
          ? yield* changed(recorded, { state: "shared", ...written.value, decidedAt: yield* now })
          : yield* changed(recorded, { state: "waiting", through: "review" });
        const moved = yield* move(settled, ["sending"]);
        return earlierAnswer(Option.getOrElse(moved, () => settled), request.input);
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
      <A, R>(effect: Effect.Effect<A, MemoryUnavailable | MemoryConflict, R>) =>
        effect.pipe(
          Effect.catchTags({
            MemoryUnavailable: () => Effect.fail(new MemoryNotAnswering()),
            MemoryConflict: () => Effect.fail(new MemoryShareChangedMeanwhile({ shareId: id })),
          }),
        );

    /**
     * Claims a waiting share for a decision, by moving it to `sending`, so a second decision on it
     * is refused, then runs `write` and saves what it answered. A write that fails leaves the share
     * waiting again.
     */
    const decide = (
      id: string,
      write: (share: MemoryShare) => Effect.Effect<Partial<MemoryShare>, MemoryUnavailable | MemoryConflict>,
    ) =>
      Effect.gen(function* () {
        const waiting = yield* open(id, "waiting");
        const claimed = yield* move(yield* changed(waiting, { state: "sending" }), ["waiting"]);
        if (Option.isNone(claimed)) return yield* closedNow(id);
        const fields = yield* answered(id)(write(claimed.value)).pipe(
          Effect.tapError(() =>
            Effect.flatMap(changed(claimed.value, { state: "waiting" }), (back) => move(back, ["sending"])),
          ),
        );
        const decided = yield* changed(claimed.value, { ...fields, decidedAt: yield* now });
        const moved = yield* move(decided, ["sending"]);
        if (Option.isNone(moved)) return yield* closedNow(id);
        return moved.value;
      });

    const keepOwn = (share: MemoryShare) =>
      store.write(hobOf(share), ownScopeOf(share), draftOf(share), { _tag: "Any" });

    return Context.make(MemoryShares, MemoryShares.of({ share })).pipe(
      Context.add(
        MemoryReviews,
        MemoryReviews.of({
          list: log.list(DECIDED_SHOWN),
          share: (id, markdown) =>
            Effect.gen(function* () {
              yield* UserSession;
              return yield* decide(id, (waiting) => {
                const edited = markdown !== undefined && markdown !== waiting.markdown;
                return Effect.map(writeShared(store, waiting, draftOf(waiting, markdown)), (written) => ({
                  state: "shared" as const,
                  markdown: markdown ?? waiting.markdown,
                  edited,
                  ...written,
                }));
              });
            }),
          keep: (id) =>
            Effect.gen(function* () {
              yield* UserSession;
              return yield* decide(id, (waiting) => Effect.as(keepOwn(waiting), { state: "kept" as const }));
            }),
          undo: (id) =>
            Effect.gen(function* () {
              yield* UserSession;
              const shared = yield* open(id, "shared");
              yield* answered(id)(
                Effect.gen(function* () {
                  const current = yield* store.page(YOU, shared.scope, shared.path);
                  // A page changed since it was shared is yours to sort out on the page, never undone over.
                  if (current === null || current.version !== shared.version) {
                    return yield* new MemoryConflict({ path: shared.path, current: current?.version ?? null });
                  }
                  yield* shared.previous === null
                    ? store.forget(YOU, shared.scope, shared.path, { _tag: "Version", version: current.version })
                    : store.restore(YOU, shared.scope, shared.path, shared.previous as MemoryVersion);
                  yield* keepOwn(shared);
                }),
              );
              const undone = yield* changed(shared, { state: "undone", decidedAt: yield* now });
              const moved = yield* move(undone, ["shared"]);
              if (Option.isNone(moved)) return yield* closedNow(id);
              return moved.value;
            }),
        }),
      ),
    );
  }),
);
