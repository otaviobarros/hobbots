import type { SkillsList } from "@hobbots/api";
import type { Skill, SkillId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { exportSkills, skillsErrorTag } from "../../api/skills.ts";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { exportRows, folderName, type HobDirectory, skillTitle } from "./skills-model.ts";
import { RevTag, ScopeTag, SkillsIcon } from "./skills-parts.tsx";

const copy = messages;

/** The folder an export went in, by its own name, as "Downloads". */
const parentName = (folder: string, name: string) => {
  const parent = folder.slice(0, Math.max(0, folder.length - name.length - 1));
  return parent.split(/[/\\]/).filter(Boolean).at(-1) ?? parent;
};

/** Skills from `~/.agents/skills`, which an export leaves out: they stay in that folder (ADR 029). */
function NotExported({ skills, folder }: { skills: ReadonlyArray<Skill>; folder: string }) {
  return (
    <section aria-label={copy.export.notExported} className="flex flex-col gap-2 rounded-card bg-card px-3.5 py-3">
      <span className="flex items-center gap-2 text-text-secondary">
        <SkillsIcon name="lock" />
        <h3 className="m-0 flex-1 text-ui font-semibold text-text-strong">{copy.export.notExported}</h3>
        <ScopeTag scope={{ _tag: "Everyone" }} label={copy.export.notExportedScope({ folder })} />
      </span>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {skills.map((skill) => (
          <li key={skill.id} className="flex items-center gap-2 text-ui text-text-strong">
            {skillTitle(skill.name)}
            <RevTag label={copy.revision({ number: skill.revisions })} />
          </li>
        ))}
      </ul>
      <span className="text-detail text-text-secondary">{copy.export.notExportedNote({ folder })}</span>
    </section>
  );
}

/**
 * Export skills (ADR 029): pick the skills, and whether to keep who gets each one, then the hub
 * writes a folder with each skill and `skills.lock.json` in your Downloads folder.
 */
export function SkillsExport({ list, hobs, say }: { list: SkillsList; hobs: HobDirectory; say: Say }) {
  const navigate = useNavigate();
  const { rows, notExported } = exportRows(list, hobs);
  const folder = folderName(list.agentsFolder.path);
  const [off, setOff] = useState<ReadonlySet<SkillId>>(() => new Set());
  const [assignments, setAssignments] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const switchHint = useId();
  const run = useMutation({ mutationFn: exportSkills });
  const picked = rows.filter((row) => !off.has(row.skill.id)).map((row) => row.skill.id);

  const start = () => {
    setFailure(null);
    const every = picked.length === rows.length;
    run.mutate(every ? { assignments } : { skillIds: picked, assignments }, {
      onSuccess: (done) => {
        say(
          {
            tone: "done",
            message: copy.export.saved({
              name: done.name,
              where: parentName(done.folder, done.name),
              count: done.skills,
            }),
          },
          { _tag: "Overview" },
        );
        void navigate({ to: "/skills", search: {} });
      },
      onError: (error) =>
        setFailure(skillsErrorTag(error) === "InvalidFolder" ? copy.export.insideHob : copy.export.failed),
    });
  };

  return (
    <div className="flex max-w-[760px] flex-col gap-[18px]">
      <header className="flex flex-col gap-1.5">
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{copy.export.title}</h2>
        <p className="m-0 text-body text-text-secondary">{copy.export.intro({ folder })}</p>
      </header>
      <ul
        aria-label={copy.export.list}
        className="m-0 flex list-none flex-col overflow-hidden rounded-card p-0 [&>li+li]:border-t [&>li+li]:border-line"
      >
        {rows.map((row) => {
          const title = skillTitle(row.skill.name);
          return (
            <li key={row.skill.id} className="flex items-center gap-3 bg-card px-3.5 py-2.5">
              <input
                type="checkbox"
                className="size-4 flex-none accent-(--color-mint-deep)"
                aria-label={copy.export.pick({ name: title })}
                checked={!off.has(row.skill.id)}
                onChange={(event) =>
                  setOff((was) => {
                    const now = new Set(was);
                    if (event.target.checked) now.delete(row.skill.id);
                    else now.add(row.skill.id);
                    return now;
                  })
                }
              />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-ui font-semibold text-text-strong">{title}</span>
                <RevTag label={copy.revision({ number: row.skill.revisions })} />
              </span>
              <ScopeTag scope={row.scope} label={row.where} />
            </li>
          );
        })}
      </ul>
      {notExported.length > 0 && <NotExported skills={notExported} folder={folder} />}
      <div className="flex items-center gap-3 rounded-card bg-card px-3.5 py-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui font-semibold text-text-strong">{copy.export.assignments}</span>
          <span id={switchHint} className="text-detail text-text-secondary">
            {copy.export.assignmentsHint}
          </span>
        </span>
        <Switch
          aria-label={copy.export.assignments}
          aria-describedby={switchHint}
          checked={assignments}
          onCheckedChange={setAssignments}
        />
      </div>
      {failure !== null && (
        <p role="alert" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={picked.length === 0 || run.isPending} onClick={start}>
          {run.isPending ? copy.export.exporting : copy.export.exportN({ count: picked.length })}
        </Button>
        <Button asChild variant="quiet">
          <Link to="/skills" search={{}}>
            {copy.export.cancel}
          </Link>
        </Button>
        <span className="ms-auto text-meta text-label">{copy.export.importHint}</span>
      </div>
    </div>
  );
}
