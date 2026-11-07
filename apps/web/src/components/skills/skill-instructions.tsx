import { SKILL_FILE_SHOWN_MAX, type SkillDetail } from "@hobbots/api";
import { type SkillFile, type SkillRevision, skillRevisionLabel } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { skillFileQuery, skillRevisionQuery } from "../../api/skills.ts";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { messages } from "./messages.ts";
import { FlagList } from "./skill-flags.tsx";
import { instructionsOf, type SkillsView, skillsSearchOf } from "./skills-model.ts";

const copy = messages;

type SkillViewOf = Extract<SkillsView, { _tag: "Skill" }>;

const isScript = (revision: SkillRevision, file: SkillFile) =>
  file.mode === "executable" || revision.flags.some((flag) => flag._tag === "Script" && flag.path === file.path);

/**
 * The files of a revision, or the ones given of it, as a skill of a set lists its own: each opens
 * read-only below the list.
 */
export function FileList({
  view,
  revision,
  files = revision.files,
}: {
  view: SkillViewOf;
  revision: SkillRevision;
  files?: ReadonlyArray<SkillFile>;
}) {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return (
    <section
      aria-label={copy.skill.files({ rev: skillRevisionLabel(revision) })}
      className="overflow-hidden rounded-card border border-line-2 bg-card"
    >
      <div className="flex items-center gap-2 border-b border-line bg-deep px-3 py-2.5 text-detail">
        <h3 className="lbl m-0 flex-1 text-label">{copy.skill.files({ rev: skillRevisionLabel(revision) })}</h3>
        <span className="text-label">{copy.skill.filesSize({ count: files.length, bytes })}</span>
      </div>
      <ul className="m-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-line">
        {files.map((file) => {
          const open = view.file === file.path;
          const script = isScript(revision, file);
          return (
            <li key={file.path}>
              <Link
                to="/skills"
                search={skillsSearchOf({ ...view, file: open ? null : file.path })}
                aria-expanded={open}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-ui text-text no-underline hover:bg-hover",
                  open && "bg-hover",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "w-[18px] text-center font-mono text-meta font-bold",
                    script ? "text-lantern" : "text-label",
                  )}
                >
                  {script ? "SH" : "MD"}
                </span>
                <span className="sr-only">{copy.skill.fileOpen}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-detail text-moonlight">{file.path}</code>
                {script && <span className="text-meta text-label">{copy.skill.script}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One file of a revision, read-only: its text, or why it is not shown, with where it is changed. */
export function FileView({
  view,
  revision,
  path,
  note,
}: {
  view: SkillViewOf;
  revision: SkillRevision;
  path: string;
  note: string;
}) {
  const read = useQuery(skillFileQuery(revision.skillId, revision.hash, path));
  return (
    <section
      aria-label={copy.file.label({ path })}
      className="overflow-hidden rounded-card border border-line-2 bg-card"
    >
      <div className="flex items-center gap-2 border-b border-line bg-deep px-3 py-2 text-detail">
        <code className="min-w-0 flex-1 truncate font-mono text-moonlight">{path}</code>
        <span className="text-meta text-label">{note}</span>
        <Button asChild variant="quiet" size="xs">
          <Link to="/skills" search={skillsSearchOf({ ...view, file: null })}>
            {copy.file.close}
          </Link>
        </Button>
      </div>
      {read.isPending && (
        <div role="status" className="flex flex-col gap-2 px-3 py-2">
          <span className="sr-only">{copy.file.loading}</span>
          <Skeleton surface="card" width="70%" />
          <Skeleton surface="card" width="50%" />
        </div>
      )}
      {read.isError && <p className="m-0 px-3 py-2 text-ui text-text-secondary">{copy.file.failed}</p>}
      {read.isSuccess &&
        (read.data.text === null ? (
          <p className="m-0 px-3 py-2 text-ui text-text-secondary">
            {read.data.size > SKILL_FILE_SHOWN_MAX
              ? copy.file.tooLong({ size: read.data.size })
              : copy.file.notText({ size: read.data.size })}
          </p>
        ) : (
          <pre className="m-0 max-h-[480px] overflow-auto px-3 py-2.5 font-mono text-detail whitespace-pre text-text">
            {read.data.text}
          </pre>
        ))}
    </section>
  );
}

/**
 * The Instructions tab: the newest revision's SKILL.md, what to look at in it, and its files. A skill
 * `fromFolder` (`~/.agents/skills`) is changed in that folder, never here (ADR 029).
 */
export function SkillInstructions({
  view,
  detail,
  fromFolder,
}: {
  view: SkillViewOf;
  detail: SkillDetail;
  fromFolder: boolean;
}) {
  const latest = detail.revisions[0];
  const read = useQuery({
    ...skillRevisionQuery(detail.skill.id, detail.skill.latest),
    enabled: latest !== undefined,
  });
  if (latest === undefined) return null;
  return (
    <div className="flex flex-col gap-4">
      {read.isPending && (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{copy.loading}</span>
          <Skeleton width="80%" />
          <Skeleton width="65%" />
        </div>
      )}
      {read.isError && <p className="m-0 text-ui text-text-secondary">{copy.failed.skill}</p>}
      {read.isSuccess && (
        <ReplyMarkdown content={instructionsOf(read.data.instructions)} streaming={false} caret={false} />
      )}
      <FlagList revision={latest} />
      <FileList view={view} revision={latest} />
      {view.file !== null && (
        <FileView
          view={view}
          revision={latest}
          path={view.file}
          note={fromFolder ? copy.agents.fileReadOnly : copy.file.readOnly}
        />
      )}
    </div>
  );
}
