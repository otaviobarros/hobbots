import { type SkillProposalCheck, type SkillProposalView, UserSession } from "@hobbots/api";
import {
  type SkillBy,
  type SkillMovedOn,
  SkillProposal,
  type SkillProposalAddedAs,
  SkillProposalClosed,
  SkillProposalNotFound,
  type SkillProposalPlan,
  type SkillProposalState,
  type SkillRevision,
  type SkillRevisionHash,
  SkillSourceUnreadable,
  skillProposalOpen,
  skillProposalStale,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option } from "effect";
import { announcer, EventPublisher } from "./ports.ts";
import { SkillProposalLog, type SkillReviewError, SkillReviews } from "./skill-proposals.ts";
import {
  rolloutTargets,
  type SkillDelivery,
  SkillFiles,
  SkillLibrary,
  type SkillRevisionAdded,
  SkillWriter,
  type WrittenFile,
} from "./skills.ts";

/**
 * Your side of skill proposals (ADR 029, Proactive hobs): what waits for you, and Add, Edit then add,
 * and Not now. A proposal is claimed before anything is written (`adding`), so a second decision is
 * refused and a stopped hub finishes it at start. Add writes it through `SkillWriter`, with the same
 * checks as any skill written in Hobbots, as a revision a hob's approved proposal made: a new skill
 * goes to the hob that proposed it, and a revision rolls out like your own edit, to every assignment
 * not held. Content an earlier revision already is brings that revision back, as a rollback does, and
 * content the newest already is changes nothing; either is said as it is. Not now leaves the library
 * as it was. Either way the hob hears how it ended in its next turn.
 */

/** How many decided proposals the list keeps after those that wait. */
const DECIDED_SHOWN = 50;

/**
 * How many times an add is written again from the skill's newest revision when another revision
 * landed while its files were copied, before it is sent back to you.
 */
const MOVED_ON_TRIES = 3;

const now = Effect.map(DateTime.now, DateTime.formatIso);

const decoder = new TextDecoder();

/** The files a proposal would add, and the newest revision a change keeps the other files of. */
interface ProposalFiles {
  readonly files: ReadonlyArray<WrittenFile>;
  readonly after: SkillRevisionHash | null;
}

export const SkillReviewsLive = Layer.effect(
  SkillReviews,
  Effect.gen(function* () {
    const log = yield* SkillProposalLog;
    const library = yield* SkillLibrary;
    const files = yield* SkillFiles;
    const writer = yield* SkillWriter;
    const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a skill proposal");

    /** A revision's `SKILL.md`, or null when the hub has no files for it. */
    const instructionsOf = (hash: SkillRevisionHash) =>
      files.read(hash, "SKILL.md").pipe(
        Effect.map((bytes) => decoder.decode(bytes)),
        Effect.orElseSucceed(() => null),
      );

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
     * The files of the revision a proposal makes with `instructions` as its `SKILL.md`: for a change,
     * every other file of the skill's newest revision too, as it is now, so a script it refers to keeps
     * its contents and its mode. A proposal changes only `SKILL.md`, and its review shows it against
     * the newest revision, so a script fixed or a file added since the hob read the skill stays as it
     * is. Files the hub cannot find are not files the skill lacks: the add is refused, never made without them.
     */
    const filesOf = (proposal: SkillProposal, instructions: string) =>
      Effect.gen(function* (): Effect.fn.Return<ProposalFiles, SkillSourceUnreadable> {
        const skillMd: WrittenFile = { path: "SKILL.md", text: instructions };
        if (proposal.skillId === null || proposal.base === null) return { files: [skillMd], after: null };
        const skill = yield* library.get(proposal.skillId);
        const newest = skill?.latest ?? proposal.base.hash;
        const revision = yield* library.revision(proposal.skillId, newest);
        if (revision === null) {
          return yield* new SkillSourceUnreadable({
            message: `The files of ${proposal.name}'s newest revision are not on this hub, so the change cannot keep them.`,
          });
        }
        const kept = yield* Effect.forEach(
          revision.files.filter((file) => file.path !== "SKILL.md"),
          (file) =>
            files.read(newest, file.path).pipe(
              Effect.mapError(
                () =>
                  new SkillSourceUnreadable({
                    message: `${file.path} of ${proposal.name}'s newest revision could not be read, so the change cannot keep it.`,
                  }),
              ),
              Effect.map((bytes): WrittenFile => ({ path: file.path, bytes, executable: file.mode === "executable" })),
            ),
        );
        return { files: [skillMd, ...kept], after: newest };
      });

    /** What the checks find in a proposal with `instructions`, as adding it now would find it. */
    const checkOf = (proposal: SkillProposal, instructions: string) =>
      Effect.gen(function* (): Effect.fn.Return<SkillProposalCheck, SkillReviewError> {
        const { files: written } = yield* filesOf(proposal, instructions);
        const checked = yield* writer.check(written);
        const same = checked.existing !== null && checked.existing.skillId === proposal.skillId;
        return { flags: checked.flags, existing: same ? (checked.existing?.number ?? null) : null };
      });

    /**
     * What adding the proposal now writes: its files, built on the skill's newest revision as it is
     * now, and the plan they make, by the revision their content is and how it changes the library.
     */
    const planOf = (adding: SkillProposal) =>
      Effect.gen(function* () {
        const { files: built, after } = yield* filesOf(adding, adding.instructions);
        const checked = yield* writer.check(built);
        const reuse =
          checked.existing?.number != null && (adding.skillId === null || checked.existing.skillId === adding.skillId)
            ? checked.existing.number
            : null;
        const as: SkillProposalAddedAs =
          reuse === null ? "new" : after === null || checked.hash === after ? "same" : "earlier";
        const plan: SkillProposalPlan = { hash: checked.hash, after, as };
        return { files: built, plan };
      });

    /** Records the plan on the claimed proposal before anything is written, so a replay finishes it. */
    const record = (adding: SkillProposal, plan: SkillProposalPlan) =>
      Effect.gen(function* () {
        const moved = yield* move(yield* changed(adding, { planned: plan }), ["adding"]);
        return Option.isSome(moved) ? moved.value : yield* closedNow(adding.id);
      });

    /**
     * Writes the files once, built on the skill's newest revision as it is now, after recording what
     * they are. When another revision landed while they were copied, the library refuses them
     * (`SkillMovedOn`), and they are planned and read again from the new newest, so nothing that
     * revision changed goes back.
     */
    const written = (adding: SkillProposal, by: SkillBy, tries: number) =>
      Effect.gen(function* (): Effect.fn.Return<
        { readonly added: SkillRevisionAdded; readonly adding: SkillProposal; readonly plan: SkillProposalPlan },
        SkillReviewError
      > {
        const { files: built, plan } = yield* planOf(adding);
        const planned = yield* record(adding, plan);
        const added = yield* writer
          .write(built, {
            by,
            ...(adding.skillId === null ? {} : { skillId: adding.skillId }),
            ...(plan.after === null ? {} : { after: plan.after }),
          })
          .pipe(
            Effect.catchTag("SkillMovedOn", (moved: SkillMovedOn) =>
              tries > 1 ? Effect.succeed(null) : Effect.fail(moved),
            ),
          );
        if (added === null) return yield* written(planned, by, tries - 1);
        return { added, adding: planned, plan };
      });

    /**
     * The revision a recorded plan wrote, when the library has it: a hub that stopped after writing
     * it finishes the plan as recorded, never what re-reading the library would make of it now.
     */
    const plannedRevision = (adding: SkillProposal) =>
      Effect.gen(function* () {
        const plan = adding.planned;
        if (plan === null) return null;
        const skillId = adding.skillId ?? (yield* library.byName(adding.name))?.id ?? null;
        const revision = skillId === null ? null : yield* library.revision(skillId, plan.hash);
        return revision === null ? null : { revision, plan };
      });

    /**
     * Gives the hob its new skill, or rolls a change out, as the plan says: a new revision as your own
     * edit does, the newest again only where it never reached, and an earlier one brought back to every
     * assignment not held, as Roll back does. It is made once for the proposal: the library records its
     * receipt with the assignments it moves, so a hub that stops and finishes it again moves nothing,
     * whatever you decided since.
     */
    const rollOut = (adding: SkillProposal, revision: SkillRevision, plan: SkillProposalPlan, by: SkillBy) =>
      Effect.gen(function* () {
        const delivery: SkillDelivery =
          adding.skillId === null
            ? {
                _tag: "Assign",
                input: {
                  skillId: revision.skillId,
                  scope: { _tag: "Hob", agentId: adding.agentId },
                  pin: revision.hash,
                  held: false,
                  onlyWhenAsked: false,
                  by,
                },
              }
            : {
                _tag: "RollOut",
                skillId: revision.skillId,
                pin: revision.hash,
                by,
                when: plan.as === "earlier" ? "always" : "pending",
              };
        const delivered = yield* library.deliver(`skill-proposal:${adding.id}`, delivery);
        if (delivered !== null) yield* announce(delivered.entries);
      });

    /**
     * Writes what a claimed proposal holds into the library, as an approved proposal of its hob, then
     * records it added. What it writes is recorded first; a hub stopped after the write finishes that
     * revision and its rollout, and one stopped before it writes nothing twice.
     */
    const write = (claimed: SkillProposal) =>
      Effect.gen(function* () {
        const by: SkillBy = { _tag: "Hob", agentId: claimed.agentId };
        const resumed = yield* plannedRevision(claimed);
        const { revision, plan, adding } =
          resumed !== null
            ? { ...resumed, adding: claimed }
            : yield* Effect.map(written(claimed, by, MOVED_ON_TRIES), (done) => ({
                revision: done.added.revision,
                plan: done.plan,
                adding: done.adding,
              }));
        yield* rollOut(adding, revision, plan, by);
        const done = yield* changed(adding, {
          state: "added",
          added: { hash: revision.hash, number: revision.number, as: plan.as },
          planned: null,
          decidedAt: yield* now,
        });
        const moved = yield* move(done, ["adding"]);
        return Option.isSome(moved) ? moved.value : yield* closedNow(adding.id);
      });

    /** Sends a proposal whose import was refused back to you, waiting, with your edit kept. */
    const sendBack = (adding: SkillProposal) =>
      Effect.flatMap(changed(adding, { state: "waiting", planned: null }), (back) => move(back, ["adding"]));

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

    const check = (id: string, instructions: string) =>
      Effect.gen(function* () {
        yield* UserSession;
        return yield* checkOf(yield* open(id), instructions);
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

    /** What a proposal's review shows beside it: what it changes, against the newest when it is stale. */
    const viewOf = (proposal: SkillProposal) =>
      Effect.gen(function* (): Effect.fn.Return<SkillProposalView> {
        // While it waits, what the checks find in it now; a draft they refuse says why when you add it.
        const found = skillProposalOpen(proposal)
          ? yield* checkOf(proposal, proposal.instructions).pipe(Effect.orElseSucceed(() => null))
          : null;
        if (proposal.skillId === null || proposal.base === null) {
          return { proposal, base: null, latest: null, rollout: null, check: found };
        }
        const skill = yield* library.get(proposal.skillId);
        const base = yield* instructionsOf(proposal.base.hash);
        const latestHash: SkillRevisionHash | null = skill?.latest ?? null;
        const latest =
          skill !== null && skillProposalOpen(proposal) && skillProposalStale(proposal, latestHash)
            ? yield* Effect.map(instructionsOf(skill.latest), (text) =>
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
          check: found,
        };
      });

    // A hub stopped while it added a proposal finishes it as it starts.
    yield* recover.pipe(Effect.forkScoped);
    return SkillReviews.of({
      list: Effect.flatMap(log.list(DECIDED_SHOWN), (proposals) => Effect.forEach(proposals, viewOf)),
      check,
      add,
      decline,
      recover,
    });
  }),
);
