import type {
  Committed,
  SkillId,
  SkillRevisionHash,
  SkillUpdate,
  SkillUpdateCheck,
  SkillUpdateProblem,
} from "@hobbots/domain";
import { Context, type Effect } from "effect";

/**
 * Updates from a source (ADR 029): what the checks of Git sources found, kept beside the library and
 * never inside it, the skills you set to Update automatically, and when the last check ran. Only an
 * accepted update reaches the library, as a revision import adds.
 */
export interface SkillUpdateLogShape {
  /** Every update that waits for you, by skill name. */
  readonly waiting: Effect.Effect<ReadonlyArray<SkillUpdate>>;
  /** A skill's update, waiting or dismissed, or null when it has none. */
  readonly get: (skillId: SkillId) => Effect.Effect<SkillUpdate | null>;
  /**
   * Records what a check found for a skill, journaled as `SkillUpdateFound`, unless the skill already
   * has an update of that content: then nothing changes, so a dismissed one stays dismissed. Null then.
   */
  readonly found: (update: SkillUpdate) => Effect.Effect<Committed<SkillUpdate> | null>;
  /** Not now: the update of `hash` leaves Updates until the source changes again. Null when it is not there. */
  readonly dismiss: (skillId: SkillId, hash: SkillRevisionHash) => Effect.Effect<Committed<SkillUpdate> | null>;
  /**
   * Takes a skill's update away, once it was accepted or the source no longer holds it; with `hash`,
   * only while it is still that content. Null when there was none.
   */
  readonly clear: (skillId: SkillId, hash?: SkillRevisionHash) => Effect.Effect<Committed<SkillId> | null>;
  /** The skills set to Update automatically. */
  readonly automatic: Effect.Effect<ReadonlyArray<SkillId>>;
  /** Turns Update automatically on or off for a skill. Null when it already was. */
  readonly setAutomatic: (skillId: SkillId, on: boolean) => Effect.Effect<Committed<boolean> | null>;
  /** The last check: when it ran, and the sources it could not read. */
  readonly lastCheck: Effect.Effect<SkillUpdateCheck>;
  /** Records a check that ran at `at`, with the sources it could not read. */
  readonly checked: (at: string, problems: ReadonlyArray<SkillUpdateProblem>) => Effect.Effect<void>;
}

export class SkillUpdateLog extends Context.Service<SkillUpdateLog, SkillUpdateLogShape>()(
  "@hobbots/agents/SkillUpdateLog",
) {}
