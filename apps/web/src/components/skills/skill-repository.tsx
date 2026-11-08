import type { SkillCandidate, SkillScan } from "@hobbots/api";
import { REPOSITORY_SKILL_ROOTS, repositorySkillCount, type SkillRepository } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  dismissSkillRepository,
  importSkillRepository,
  scanSkillRepository,
  skillRepositoriesQuery,
} from "../../api/skill-repositories.ts";
import { refreshSkills, skillsErrorTag } from "../../api/skills.ts";
import { ImportCandidates } from "./import-candidates.tsx";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, importable, projectName, skillsSearchOf, skillTitle } from "./skills-model.ts";
import { SkillsIcon } from "./skills-parts.tsx";

/**
 * A repository's own skills (ADR 029, Scopes, #1098): the offer on the overview, and Add a skill ›
 * From a project. No hob loads them from the clone; importing reads the repository's default branch
 * and gives them to that project, where they get revisions, checks and updates like any skill from Git.
 */

const copy = messages.repository;

/** Which of the two folders the clone's skills are in, as the offer names them. */
const rootsOf = (repository: SkillRepository) =>
  REPOSITORY_SKILL_ROOTS.filter((root) => repository.skills.some((folder) => folder.startsWith(`${root}/`)));

const hobName = (repository: SkillRepository, hobs: HobDirectory) =>
  hobs.get(repository.agentId)?.name ?? messages.scopes.formerHob;

/** Not now: the offer goes, and the page says until when. */
const useDismiss = (say: Say) => {
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

/** The repositories whose skills Hobbots still offers, one card each, above the library. */
export function RepositoryOffers({ hobs, say }: { hobs: HobDirectory; say: Say }) {
  const offered = (useQuery(skillRepositoriesQuery).data?.repositories ?? []).filter((one) => one.offered);
  return offered.map((repository) => <Offer key={repository.project} repository={repository} hobs={hobs} say={say} />);
}

/** What Add a skill › From a project says under its name: how many skills the first repository holds. */
export const useRepositoryTab = (): string => {
  const [first] = useQuery(skillRepositoriesQuery).data?.repositories ?? [];
  return first === undefined
    ? messages.import.tabs.repo.sub
    : messages.import.repoFound({ count: repositorySkillCount(first.skills), name: projectName(first.project) });
};

/** The candidates picked first: every one that can be imported, the first of each name. */
const firstOfEach = (candidates: ReadonlyArray<SkillCandidate>): ReadonlySet<string> => {
  const names = new Set<string>();
  const picked = new Set<string>();
  for (const one of candidates) {
    if (!importable(one) || one.name === null || names.has(one.name)) continue;
    names.add(one.name);
    picked.add(one.folder);
  }
  return picked;
};

/** What the default branch holds: the skills to pick, Import for the project, and Not now. */
function RepositoryScan({
  repository,
  scan,
  hobs,
  say,
}: {
  repository: SkillRepository;
  scan: SkillScan;
  hobs: HobDirectory;
  say: Say;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dismiss = useDismiss(say);
  const [picked, setPicked] = useState(() => firstOfEach(scan.candidates));
  const [failure, setFailure] = useState<string | null>(null);
  const [clash, setClash] = useState<string | null>(null);
  const name = projectName(repository.project);
  const chosen = scan.candidates.filter((one) => importable(one) && picked.has(one.folder));
  const importing = useMutation({
    mutationFn: () =>
      importSkillRepository({
        project: repository.project,
        scanned: chosen.flatMap((one) => (one.hash === null ? [] : [{ folder: one.folder, hash: one.hash }])),
      }),
    onSuccess: async (done) => {
      const names = done.imported.map((one) => skillTitle(one.skill.name));
      say(
        { tone: "done", message: copy.imported({ names, name, hob: hobName(repository, hobs) }) },
        { _tag: "Overview" },
      );
      await refreshSkills(queryClient);
      void navigate({ to: "/skills", search: {} });
    },
    onError: (error) => setFailure(skillsErrorTag(error) === "SkillScanOutdated" ? copy.moved : copy.failed),
  });
  if (scan.candidates.length === 0) return <p className="m-0 text-ui text-text-secondary">{copy.nothing}</p>;
  // Only one skill of a name can come in: picking one leaves out any other of its name.
  const toggle = (folder: string, on: boolean) => {
    const named = scan.candidates.find((one) => one.folder === folder)?.name ?? null;
    const others = scan.candidates.filter(
      (one) => one.name === named && one.folder !== folder && picked.has(one.folder),
    );
    setClash(on && others.length > 0 && named !== null ? copy.sameName({ name: skillTitle(named) }) : null);
    setPicked((was) => {
      const now = new Set(was);
      if (!on) now.delete(folder);
      else {
        for (const other of others) now.delete(other.folder);
        now.add(folder);
      }
      return now;
    });
  };
  const busy = importing.isPending || dismiss.isPending;
  return (
    <div aria-busy={busy} className="flex flex-col gap-3.5">
      <ImportCandidates candidates={scan.candidates} picked={picked} onToggle={toggle} />
      {clash !== null && <p className="m-0 text-detail text-label">{clash}</p>}
      {failure !== null && (
        <p role="alert" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={chosen.length === 0 || busy} onClick={() => importing.mutate()}>
          {importing.isPending ? messages.import.importing : copy.importN({ count: chosen.length, name })}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={() => dismiss.mutate(repository.project)}>
          {copy.notNow}
        </Button>
      </div>
    </div>
  );
}

/** The repositories to pick from, when hobs work in more than one that holds skills. */
function RepositoryPicker({
  repositories,
  open,
  hobs,
}: {
  repositories: ReadonlyArray<SkillRepository>;
  open: SkillRepository;
  hobs: HobDirectory;
}) {
  if (repositories.length < 2) return null;
  return (
    <nav aria-label={copy.pick} className="flex flex-wrap gap-2">
      {repositories.map((one) => (
        <Link
          key={one.project}
          to="/skills"
          search={skillsSearchOf({ _tag: "Add", from: "repo", project: one.project })}
          aria-current={one.project === open.project ? "page" : undefined}
          className={cn(
            "flex flex-col rounded-card border-(length:--edge) border-solid border-line-2 bg-card px-3 py-2 text-start text-text-strong no-underline hover:border-control",
            one.project === open.project && "border-focus-ring shadow-[0_0_0_1px_var(--color-focus-ring)]",
          )}
        >
          <span className="text-ui font-semibold">{projectName(one.project)}</span>
          <span className="text-meta text-label">{copy.pickLine({ hob: hobName(one, hobs), folder: one.folder })}</span>
        </Link>
      ))}
    </nav>
  );
}

/** One repository's default branch, read when it opens. */
function RepositoryRead({ repository, hobs, say }: { repository: SkillRepository; hobs: HobDirectory; say: Say }) {
  // Kept apart from the library's reads, so a change to the library never fetches the repository again.
  const read = useQuery({
    queryKey: ["skill-repository-scan", repository.project],
    queryFn: () => scanSkillRepository(repository.project),
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (read.isError)
    return (
      <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-ui text-text">
        <span className="flex-1">{copy.unreadable}</span>
        <Button variant="outline" size="xs" disabled={read.isFetching} onClick={() => void read.refetch()}>
          {copy.retry}
        </Button>
      </p>
    );
  if (read.data === undefined)
    return (
      <p role="status" className="m-0 text-ui text-text-secondary">
        {copy.reading}
      </p>
    );
  const folders = rootsOf(repository).map((root) => `${repository.folder}/${root}`);
  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 text-ui text-text-secondary">
        {copy.found({ folders, commit: read.data.scan.commit, name: projectName(repository.project) })}
      </p>
      <RepositoryScan key={read.dataUpdatedAt} repository={repository} scan={read.data.scan} hobs={hobs} say={say} />
    </div>
  );
}

/** Add a skill › From a project: the skills a repository a hob works in holds, read from its default branch. */
export function RepositorySource({
  project,
  hobs,
  say,
}: {
  project: string | undefined;
  hobs: HobDirectory;
  say: Say;
}) {
  const repositories = useQuery(skillRepositoriesQuery);
  const all = repositories.data?.repositories ?? [];
  const open = all.find((one) => one.project === project) ?? all[0];
  if (repositories.data === undefined)
    return (
      <p role="status" className="m-0 text-ui text-text-secondary">
        {messages.loading}
      </p>
    );
  if (open === undefined) return <p className="m-0 text-ui text-text-secondary">{copy.none}</p>;
  return (
    <div className="flex flex-col gap-3.5">
      <RepositoryPicker repositories={all} open={open} hobs={hobs} />
      <RepositoryRead key={open.project} repository={open} hobs={hobs} say={say} />
    </div>
  );
}
