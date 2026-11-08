import type { MemoryProjectIdentity } from "@hobbots/domain";
import { Context, type Effect } from "effect";

/**
 * Where Hobbots stopped offering a repository's own skills (ADR 029, Scopes, #1098): for each project,
 * the skill folders its repository held when you imported them or said Not now. The offer comes back
 * only when the repository holds a skill folder that is not among them.
 */
export interface SkillRepositoryOffersShape {
  /** The skill folders each closed offer saw, by project. */
  readonly closed: Effect.Effect<ReadonlyMap<MemoryProjectIdentity, ReadonlyArray<string>>>;
  /** Closes the project's offer at `folders`, replacing what it saw before. */
  readonly close: (project: MemoryProjectIdentity, folders: ReadonlyArray<string>, at: string) => Effect.Effect<void>;
}

export class SkillRepositoryOffers extends Context.Service<SkillRepositoryOffers, SkillRepositoryOffersShape>()(
  "@hobbots/agents/SkillRepositoryOffers",
) {}
