import { REPOSITORY_SKILL_ROOTS, repositorySkillCount, type SkillRepository } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { dismissSkillRepository, skillRepositoriesQuery } from "../../api/skill-repositories.ts";
import { refreshSkills } from "../../api/skills.ts";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, projectName, skillsSearchOf } from "./skills-model.ts";
import { SkillsIcon } from "./skills-parts.tsx";

/**
 * The offer of a repository's own skills (ADR 029, Scopes, #1098): one card per repository on the
 * overview, with See them and Not now, and what Add a skill › From a project says under its name.
 */

const copy = messages.repository;

/** Which of the two folders the clone's skills are in, as the offer names them. */
export const rootsOf = (repository: SkillRepository) =>
  REPOSITORY_SKILL_ROOTS.filter((root) => repository.skills.some((folder) => folder.startsWith(`${root}/`)));

export const hobName = (repository: SkillRepository, hobs: HobDirectory) =>
  hobs.get(repository.agentId)?.name ?? messages.scopes.formerHob;

/** Not now: the offer goes, and the page says until when. */
export const useDismiss = (say: Say) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: dismissSkillRepository,
    onSuccess: async () => {
      say({ tone: "done", message: copy.dismissed }, { _tag: "Overview" });
      await refreshSkills(queryClient);
    },
    onError: () => say({ tone: "failed", message: copy.dismissFailed }),
  });
};

function Offer({ repository, hobs, say }: { repository: SkillRepository; hobs: HobDirectory; say: Say }) {
  const dismiss = useDismiss(say);
  const name = projectName(repository.project);
  return (
    <section
      aria-label={copy.offer}
      className="flex items-center gap-3 rounded-card border-(length:--edge) border-dashed border-line-2 px-4 py-3.5 max-[900px]:flex-wrap"
    >
      <span className="text-text-secondary">
        <SkillsIcon name="repo" size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="text-body font-semibold text-text-strong">
          {copy.offerTitle({ count: repositorySkillCount(repository.skills), name })}
        </b>
        <span className="text-detail text-text-secondary">
          {copy.offerLine({ roots: rootsOf(repository), hob: hobName(repository, hobs), folder: repository.folder })}
        </span>
      </span>
      <Button asChild variant="outline" size="sm">
        <Link to="/skills" search={skillsSearchOf({ _tag: "Add", from: "repo", project: repository.project })}>
          {copy.see}
        </Link>
      </Button>
      <Button variant="quiet" size="sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(repository.project)}>
        {copy.notNow}
      </Button>
    </section>
  );
}

/** A read that failed: what happened, and Try again. */
export function ReadFailed({ text, retrying, onRetry }: { text: string; retrying: boolean; onRetry: () => void }) {
  return (
    <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
      <span className="flex-1">{text}</span>
      <Button variant="outline" size="xs" disabled={retrying} onClick={onRetry}>
        {copy.retry}
      </Button>
    </p>
  );
}

/** The repositories whose skills Hobbots still offers, one card each, above the library. */
export function RepositoryOffers({ hobs, say }: { hobs: HobDirectory; say: Say }) {
  const read = useQuery(skillRepositoriesQuery);
  if (read.isError && read.data === undefined)
    return <ReadFailed text={copy.listFailed} retrying={read.isFetching} onRetry={() => void read.refetch()} />;
  const offered = (read.data?.repositories ?? []).filter((one) => one.offered);
  return offered.map((repository) => <Offer key={repository.project} repository={repository} hobs={hobs} say={say} />);
}

/** What Add a skill › From a project says under its name: how many skills the first repository holds. */
export const useRepositoryTab = (): string => {
  const [first] = useQuery(skillRepositoriesQuery).data?.repositories ?? [];
  return first === undefined
    ? messages.import.tabs.repo.sub
    : messages.import.repoFound({ count: repositorySkillCount(first.skills), name: projectName(first.project) });
};
