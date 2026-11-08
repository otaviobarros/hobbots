import { SkillLibrary, SkillUpdateLog } from "@hobbots/agents";
import { HobbotsApi, SkillMissing } from "@hobbots/api";
import { type SkillId, skillUpdateCheckDue } from "@hobbots/domain";
import { SkillUpdates } from "@hobbots/skills";
import { DateTime, Duration, Effect, Layer, Option, Schedule } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { importError } from "./skills.ts";

/**
 * Updates from a source over HTTP (ADR 029, Updates from a source), and the check the hub runs on its
 * own once a day. Every decision here is yours: a device session makes it, and no hob reaches these
 * routes. Without a skills library nothing waits, and nothing is checked.
 */

const NO_UPDATES = { updates: [], automatic: [], checkedAt: null, problems: [] };

/** How often the hub asks whether a day passed since the last check, and how long it waits after it starts. */
const LOOK_EVERY = Duration.hours(1);
const FIRST_LOOK_AFTER = Duration.minutes(1);

export const SkillUpdatesHandlers = HttpApiBuilder.group(HobbotsApi, "skillUpdates", (handlers) =>
  Effect.gen(function* () {
    const services = Option.all([
      yield* Effect.serviceOption(SkillUpdates),
      yield* Effect.serviceOption(SkillUpdateLog),
      yield* Effect.serviceOption(SkillLibrary),
    ]);
    if (Option.isNone(services)) {
      const none = ({ params }: { readonly params: { readonly skillId: string } }) =>
        Effect.fail(new SkillMissing({ id: params.skillId }));
      return handlers.handleAll({
        list: () => Effect.succeed(NO_UPDATES),
        check: () => Effect.succeed({ ...NO_UPDATES, updated: [] }),
        accept: none,
        dismiss: none,
        automatic: none,
      });
    }
    const [updates, log, library] = services.value;

    const view = Effect.gen(function* () {
      const last = yield* log.lastCheck;
      return {
        updates: yield* log.waiting,
        automatic: yield* log.automatic,
        checkedAt: last.checkedAt,
        problems: last.problems,
      };
    });

    /** A skill whose revisions come from a Git source: the only kind a check follows. */
    const fromGit = (skillId: SkillId) =>
      Effect.gen(function* () {
        const skill = yield* library.get(skillId);
        const source = (yield* library.sources).find((one) => one.id === skill?.sourceId);
        if (skill === null || source?.origin._tag !== "Git") return yield* new SkillMissing({ id: skillId });
        return skill;
      });

    return handlers.handleAll({
      list: () => view,
      check: () =>
        Effect.gen(function* () {
          const done = yield* updates.check;
          return { ...(yield* view), updated: done.updated };
        }),
      accept: ({ params, payload }) =>
        updates.accept(params.skillId, payload.hash, { _tag: "You" }).pipe(Effect.mapError(importError)),
      dismiss: ({ params, payload }) =>
        Effect.gen(function* () {
          const dismissed = yield* updates.dismiss(params.skillId, payload.hash);
          if (dismissed === null) return yield* new SkillMissing({ id: payload.hash });
          return yield* view;
        }),
      automatic: ({ params, payload }) =>
        Effect.gen(function* () {
          yield* fromGit(params.skillId);
          yield* updates.setAutomatic(params.skillId, payload.on);
          return yield* view;
        }),
    });
  }),
);

/**
 * The hub's own check of Git sources (ADR 029): a minute after it starts and then every hour, it
 * checks when a day or more passed since the last check, whoever ran it. A check that fails is
 * logged, and the next look tries again.
 */
export const SkillUpdateChecks = Layer.effectDiscard(
  Effect.gen(function* () {
    const services = Option.all([
      yield* Effect.serviceOption(SkillUpdates),
      yield* Effect.serviceOption(SkillUpdateLog),
    ]);
    if (Option.isNone(services)) return;
    const [updates, log] = services.value;
    const look = Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      if (!skillUpdateCheckDue(yield* log.lastCheck, now)) return;
      const done = yield* updates.check;
      if (done.problems.length > 0) yield* Effect.logWarning("Some skill sources could not be checked", done.problems);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not check skill sources", cause)));
    yield* look.pipe(Effect.repeat(Schedule.spaced(LOOK_EVERY)), Effect.delay(FIRST_LOOK_AFTER), Effect.forkScoped);
  }),
);
