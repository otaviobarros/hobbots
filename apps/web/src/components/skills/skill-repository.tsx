import type { SkillCandidate, SkillScan } from "@hobbots/api";
import type { SkillRepository } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { importSkillRepository, scanSkillRepository, skillRepositoriesQuery } from "../../api/skill-repositories.ts";
import { refreshSkills, skillsErrorTag } from "../../api/skills.ts";
import { ImportCandidates } from "./import-candidates.tsx";
import { messages } from "./messages.ts";
import { hobName, ReadFailed, rootsOf, useDismiss } from "./skill-repository-offer.tsx";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, importable, projectName, skillsSearchOf, skillTitle } from "./skills-model.ts";

/**
 * A repository's own skills (ADR 029, Scopes, #1098): Add a skill › From a project. No hob loads them from the clone; importing reads the repository's default branch
 * and gives them to that project, where they get revisions, checks and updates like any skill from Git.
 */

const copy = messages.repository;

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
    return <ReadFailed text={copy.unreadable} retrying={read.isFetching} onRetry={() => void read.refetch()} />;
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
  if (repositories.isError && repositories.data === undefined)
    return (
      <ReadFailed
        text={copy.listFailed}
        retrying={repositories.isFetching}
        onRetry={() => void repositories.refetch()}
      />
    );
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
