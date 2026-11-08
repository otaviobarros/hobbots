import type { MemoryProjectIdentity, SkillRevisionHash } from "@hobbots/domain";
import { queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

/**
 * A repository's own skills (ADR 029, Scopes): the repositories hobs work in that hold skills in
 * `.claude/skills` or `.agents/skills`, offered once per project, and imported from the repository's
 * default branch into that project. Under the skills' key, so reading the library again after a change
 * reads them too.
 */
export const skillRepositoriesQuery = queryOptions({
  queryKey: ["skills", "repositories"] as const,
  queryFn: () => call((c) => c.skillRepositories.list()),
});

/** Reads the project's repository at its default branch, writing nothing. */
export const scanSkillRepository = (project: MemoryProjectIdentity) =>
  call((c) => c.skillRepositories.scan({ payload: { project } }));

/** Imports what a scan found in the picked folders, and gives each skill to the project. */
export const importSkillRepository = (input: {
  project: MemoryProjectIdentity;
  scanned: ReadonlyArray<{ folder: string; hash: SkillRevisionHash }>;
}) => call((c) => c.skillRepositories.import({ payload: input }));

/** Not now: the offer goes until the repository holds a skill it does not hold now. */
export const dismissSkillRepository = (project: MemoryProjectIdentity) =>
  call((c) => c.skillRepositories.dismiss({ payload: { project } }));
