import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  announcer,
  EventPublisher,
  rolloutTargets,
  SkillFiles,
  SkillLibrary,
  SkillProposalLog,
  type SkillReviewError,
  SkillReviews,
} from "@hobbots/agents";
import {
  HobbotsApi,
  SkillMissing,
  SkillProposalDecided,
  SkillProposalMissing,
  type SkillProposalView,
  UserSession,
} from "@hobbots/api";
import {
  type SkillBy,
  SkillProposal,
  SkillProposalClosed,
  SkillProposalNotFound,
  type SkillProposalState,
  type SkillRevisionHash,
  SkillSourceUnreadable,
  skillProposalOpen,
  skillProposalStale,
} from "@hobbots/domain";
import { SkillImporter, type WrittenFile } from "@hobbots/skills";
import { DateTime, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { importError } from "./skills.ts";

/**
 * Your side of skill proposals (ADR 029, Proactive hobs): what waits for you, and Add, Edit then add,
 * and Not now. A proposal is claimed before anything is written (`adding`), so a second decision is
 * refused and a stopped hub finishes it at start. Add imports it like any skill written in Hobbots,
 * through the same checks, as a revision a hob's approved proposal made: a new skill goes to the hob
 * that proposed it, and a revision rolls out like your own edit, to every assignment not held. Not
 * now leaves the library as it was. Either way the hob hears how it ended in its next turn.
 */

/** How many decided proposals the list keeps after those that wait. */
const DECIDED_SHOWN = 50;

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** A revision's `SKILL.md`, or null when the hub has no files for it. */
const instructionsOf = (folder: string | null) =>
  folder === null
    ? Effect.succeed(null)
    : Effect.promise(() => readFile(join(folder, "SKILL.md"), "utf8").catch(() => null));

export const SkillReviewsLive = Layer.effect(
  SkillReviews,
  Effect.gen(function* () {
    const log = yield* SkillProposalLog;
    const library = yield* SkillLibrary;
    const files = yield* SkillFiles;
    const importer = yield* SkillImporter;
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a skill proposal");

    /** Moves `proposal` to its new state from one of `from`, announced, or None when it moved on meanwhile. */
    const move = (proposal: SkillProposal, from: ReadonlyArray<SkillProposalState>) =>
      Effect.gen(function* () {
        const moved = yield* log.move(proposal, from);
        if (Option.isNone(moved)) return Option.none<SkillProposal>();
        yield* announce(moved.value.entries);
        return Option.some(moved.value.value);
      });

    const changed = (proposal: SkillProposal, fields: Partial<SkillProposal>) =>
      Effect.map(now, (at) => new SkillProposal({ ...proposal, ...fields, updatedAt: at }));

    /** The proposal `id`, when it is `waiting`. */
    const open = (id: string) =>
      Effect.gen(function* () {
        const found = yield* log.get(id);
        if (Option.isNone(found)) return yield* new SkillProposalNotFound({ id });
        if (found.value.state !== "waiting") return yield* new SkillProposalClosed({ id, state: found.value.state });
        return found.value;
      });

    const closedNow = (id: string) =>
      Effect.flatMap(log.get(id), (current) =>
        Effect.fail(
          Option.isSome(current)
            ? new SkillProposalClosed({ id, state: current.value.state })
            : new SkillProposalNotFound({ id }),
        ),
      );

    /**
     * The files of the revision a proposal makes: its `SKILL.md`, and for a change, every other file
     * of the skill's newest revision, as it is now, so a script it refers to keeps its contents and
     * its mode. A proposal changes only `SKILL.md`, and its review shows it against the newest
     * revision, so a script fixed or a file added since the hob read the skill stays as it is.
     */
    const filesOf = (proposal: SkillProposal) =>
      Effect.gen(function* () {
        const skillMd: WrittenFile = { path: "SKILL.md", text: proposal.instructions };
        if (proposal.skillId === null || proposal.base === null) return [skillMd];
        const skill = yield* library.get(proposal.skillId);
        const newest = skill?.latest ?? proposal.base.hash;
        const revision = yield* library.revision(proposal.skillId, newest);
        const folder = yield* files.folder(newest);
        // Files the hub cannot find are not files the skill lacks: the add is refused, never made without them.
        if (revision === null || folder === null) {
          return yield* new SkillSourceUnreadable({
            message: `The files of ${proposal.name}'s newest revision are not on this hub, so the change cannot keep them.`,
          });
        }
        const kept = yield* Effect.forEach(
          revision.files.filter((file) => file.path !== "SKILL.md"),
          (file) =>
            Effect.tryPromise({
              try: () => readFile(join(folder, file.path)),
              catch: () =>
                new SkillSourceUnreadable({
                  message: `${file.path} of ${proposal.name}'s newest revision could not be read, so the change cannot keep it.`,
                }),
            }).pipe(
              Effect.map((bytes): WrittenFile => ({ path: file.path, bytes, executable: file.mode === "executable" })),
            ),
        );
        return [skillMd, ...kept];
      });

    /**
     * Writes what a claimed proposal holds into the library, as an approved proposal of its hob, then
     * records it added. Importing the same content again finds the revision it already is, and an
     * assignment or a rollout to it moves nothing twice, so a hub stopped part way finishes it whole.
     */
    const write = (adding: SkillProposal) =>
      Effect.gen(function* () {
        const by: SkillBy = { _tag: "Hob", agentId: adding.agentId };
        const [added] = yield* importer.add(
          { _tag: "Written", files: yield* filesOf(adding) },
          { by, ...(adding.skillId === null ? {} : { skillId: adding.skillId }) },
        );
        if (added === undefined) return yield* new SkillProposalNotFound({ id: adding.id });
        const { revision } = added;
        if (adding.skillId === null) {
          const assigned = yield* library.assign({
            skillId: revision.skillId,
            scope: { _tag: "Hob", agentId: adding.agentId },
            pin: revision.hash,
            held: false,
            onlyWhenAsked: false,
            by,
          });
          yield* announce(assigned.entries);
        } else {
          const rolled = yield* library.rollOutRevision(revision.skillId, revision.hash, by, "pending");
          yield* announce(rolled.entries);
        }
        const done = yield* changed(adding, {
          state: "added",
          added: { hash: revision.hash, number: revision.number },
          decidedAt: yield* now,
        });
        const moved = yield* move(done, ["adding"]);
        return Option.isSome(moved) ? moved.value : yield* closedNow(adding.id);
      });

    /** Sends a proposal whose import was refused back to you, waiting, with your edit kept. */
    const sendBack = (adding: SkillProposal) =>
      Effect.flatMap(changed(adding, { state: "waiting" }), (back) => move(back, ["adding"]));

    const add = (id: string, instructions: string | undefined) =>
      Effect.gen(function* () {
        yield* UserSession;
        const waiting = yield* open(id);
        const text = instructions ?? waiting.instructions;
        const claim = yield* changed(waiting, {
          state: "adding",
          instructions: text,
          edited: waiting.edited || text !== waiting.instructions,
        });
        const claimed = yield* move(claim, ["waiting"]);
        if (Option.isNone(claimed)) return yield* closedNow(id);
        return yield* write(claimed.value).pipe(
          Effect.tapError((error) => (error._tag === "SkillProposalClosed" ? Effect.void : sendBack(claimed.value))),
        );
      });

    const decline = (id: string) =>
      Effect.gen(function* () {
        yield* UserSession;
        const waiting = yield* open(id);
        const moved = yield* move(yield* changed(waiting, { state: "declined", decidedAt: yield* now }), ["waiting"]);
        return Option.isSome(moved) ? moved.value : yield* closedNow(id);
      });

    /** Finishes each proposal a stopped hub left `adding`; one the checks now refuse waits for you again. */
    const recover = Effect.gen(function* () {
      for (const proposal of yield* log.list(0)) {
        if (proposal.state !== "adding") continue;
        yield* write(proposal).pipe(
          Effect.catch((error: SkillReviewError) =>
            error._tag === "SkillProposalClosed" ? Effect.void : Effect.asVoid(sendBack(proposal)),
          ),
          // One proposal that cannot be finished never keeps the next from being finished.
          Effect.catchCause((cause) =>
            Effect.logWarning(`Could not finish adding skill proposal ${proposal.id}`, cause),
          ),
        );
      }
    });

    // A hub stopped while it added a proposal finishes it as it starts.
    yield* recover.pipe(Effect.forkScoped);
    return SkillReviews.of({ list: log.list(DECIDED_SHOWN), add, decline, recover });
  }),
);

/** A review error in the words of the HTTP contract. */
const reviewError = (error: SkillReviewError) => {
  switch (error._tag) {
    case "SkillProposalNotFound":
      return new SkillProposalMissing({ proposalId: error.id });
    case "SkillProposalClosed":
      return new SkillProposalDecided({ proposalId: error.id, state: error.state });
    default:
      return importError(error);
  }
};

export const SkillProposalsHandlers = HttpApiBuilder.group(HobbotsApi, "skillProposals", (handlers) =>
  Effect.gen(function* () {
    const services = Option.all([
      yield* Effect.serviceOption(SkillReviews),
      yield* Effect.serviceOption(SkillLibrary),
      yield* Effect.serviceOption(SkillFiles),
      yield* Effect.serviceOption(SkillProposalLog),
    ]);
    if (Option.isNone(services)) {
      const none = ({ params }: { readonly params: { readonly proposalId: string } }) =>
        Effect.fail(new SkillProposalMissing({ proposalId: params.proposalId }));
      return handlers.handleAll({
        list: () => Effect.succeed({ proposals: [] }),
        add: none,
        decline: none,
        feedback: ({ params }) => Effect.fail(new SkillMissing({ id: params.skillId })),
      });
    }
    const [reviews, library, files, log] = services.value;

    /** What a proposal's review shows beside it: what it changes, against the newest when it is stale. */
    const viewOf = (proposal: SkillProposal) =>
      Effect.gen(function* (): Effect.fn.Return<SkillProposalView> {
        if (proposal.skillId === null || proposal.base === null) {
          return { proposal, base: null, latest: null, rollout: null };
        }
        const skill = yield* library.get(proposal.skillId);
        const base = yield* instructionsOf(yield* files.folder(proposal.base.hash));
        const latestHash: SkillRevisionHash | null = skill?.latest ?? null;
        const latest =
          skill !== null && skillProposalOpen(proposal) && skillProposalStale(proposal, latestHash)
            ? yield* Effect.map(instructionsOf(yield* files.folder(skill.latest)), (text) =>
                text === null ? null : { number: skill.revisions, instructions: text },
              )
            : null;
        const assignments = yield* library.assignments(proposal.skillId);
        // Where adding it would reach: every assignment not held. The new revision's hash is not known
        // until it is written, so none is on it yet.
        const targets = rolloutTargets(assignments, proposal.skillId, "" as SkillRevisionHash);
        return {
          proposal,
          base,
          latest,
          rollout: { scopes: targets.map((one) => one.scope), held: assignments.filter((one) => one.held).length },
        };
      });

    return handlers.handleAll({
      list: () =>
        Effect.map(
          Effect.flatMap(reviews.list, (proposals) => Effect.forEach(proposals, viewOf)),
          (proposals) => ({ proposals }),
        ),
      add: ({ params, payload }) =>
        reviews.add(params.proposalId, payload.instructions).pipe(Effect.mapError(reviewError)),
      decline: ({ params }) => reviews.decline(params.proposalId).pipe(Effect.mapError(reviewError)),
      feedback: ({ params }) =>
        Effect.gen(function* () {
          if ((yield* library.get(params.skillId)) === null) return yield* new SkillMissing({ id: params.skillId });
          return { feedback: yield* log.feedback(params.skillId) };
        }),
    });
  }),
);
