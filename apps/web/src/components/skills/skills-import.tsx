import type { SkillScan, SkillSourcePayload } from "@hobbots/api";
import type { Agent, MemoryProjectIdentity, SkillId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { scanSkills, skillsErrorTag } from "../../api/skills.ts";
import { WriteOne } from "./draft-with-hob.tsx";
import { GiveChoice, type GiveTo } from "./give-choice.tsx";
import { ImportCandidates, ImportRefused } from "./import-candidates.tsx";
import { FileSource, GitSource } from "./import-sources.tsx";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, type ImportFrom, importable, scopeName, skillsSearchOf } from "./skills-model.ts";
import { SkillsIcon } from "./skills-parts.tsx";
import { giveAll, useSkillWrites } from "./use-skill-writes.ts";

const copy = messages;

const TABS: ReadonlyArray<{ from: ImportFrom; icon: "git" | "file" | "write" }> = [
  { from: "git", icon: "git" },
  { from: "file", icon: "file" },
  { from: "write", icon: "write" },
];

function SourceTabs({ from }: { from: ImportFrom }) {
  return (
    <nav aria-label={copy.import.from} className="grid grid-cols-3 gap-2.5 max-[900px]:grid-cols-1">
      {TABS.map((tab) => {
        const on = tab.from === from;
        return (
          <Link
            key={tab.from}
            to="/skills"
            search={skillsSearchOf({ _tag: "Add", from: tab.from })}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex flex-col items-start gap-1 rounded-card border-(length:--edge) border-solid border-line-2 bg-card p-3.5 text-start text-text-strong no-underline hover:border-control",
              on && "border-focus-ring shadow-[0_0_0_1px_var(--color-focus-ring)]",
            )}
          >
            <span className="text-text-secondary">
              <SkillsIcon name={tab.icon} size={18} />
            </span>
            <span className="text-ui font-semibold">{copy.import.tabs[tab.from].label}</span>
            <span className="text-meta text-label">{copy.import.tabs[tab.from].sub}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** What a scan found: the skills to pick, who gets them, and Import. */
function ScanResult({
  source,
  scan,
  active,
  projects,
  hobs,
  say,
}: {
  source: SkillSourcePayload;
  scan: SkillScan;
  active: ReadonlyArray<Agent>;
  projects: ReadonlyArray<MemoryProjectIdentity>;
  hobs: HobDirectory;
  say: Say;
}) {
  const navigate = useNavigate();
  const writes = useSkillWrites();
  const can = scan.candidates.filter(importable).map((candidate) => candidate.folder);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(can));
  const [give, setGive] = useState<GiveTo>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The skills this scan already added: Import again gives them out, and imports nothing twice.
  const [added, setAdded] = useState<ReadonlyArray<SkillId> | null>(null);
  // What importing an export gave out, kept for when giving out fails and Import runs again.
  const [given, setGiven] = useState<{ readonly assigned: number; readonly leftOut: number } | null>(null);
  if (scan.candidates.length === 0) return <p className="m-0 text-ui text-text-secondary">{copy.import.none}</p>;
  if (scan.candidates.every((candidate) => candidate.refusal !== null))
    return <ImportRefused candidates={scan.candidates} />;
  const folders = can.filter((folder) => picked.has(folder));

  // A Hobbots export brings who gets each skill with it, so it is not given out again here.
  const exported = scan.exported;
  const keepsAssignments = exported !== null && exported.assignments > 0;

  const importPicked = async () => {
    // Only what this scan found is added: a branch that moved on since is refused, not imported unseen.
    const scanned = scan.candidates.flatMap((one) =>
      one.hash !== null && folders.includes(one.folder) ? [{ folder: one.folder, hash: one.hash }] : [],
    );
    // An export's lock is bound too: it says who gets each skill, and which older revisions come.
    const result = await writes.add.mutateAsync({ source, folders, scanned, scannedLock: scan.exported?.lock ?? null });
    setGiven({ assigned: result.assigned.length, leftOut: result.leftOut });
    return {
      ids: result.imported.map((one) => one.skill.id),
      assigned: result.assigned.length,
      leftOut: result.leftOut,
    };
  };

  // Two saves, each kept once made: the import, then giving each skill out. What failed is said as such.
  const run = async () => {
    setFailure(null);
    let ids = added;
    let fromExport = given;
    try {
      if (ids === null) {
        const result = await importPicked();
        ids = result.ids;
        fromExport = { assigned: result.assigned, leftOut: result.leftOut };
      }
    } catch (error) {
      setFailure(skillsErrorTag(error) === "SkillScanOutdated" ? copy.import.moved : copy.import.failed);
      return;
    }
    setAdded(ids);
    if (give !== null) {
      const given = await giveAll(writes, ids, give);
      if (!given) return setFailure(copy.import.notGiven({ count: ids.length, who: scopeName(give, hobs) }));
    }
    const count = ids.length;
    const message =
      exported !== null && fromExport !== null
        ? copy.import.importedSet({ count, given: fromExport.assigned, left: fromExport.leftOut })
        : give === null
          ? copy.import.imported({ count })
          : copy.import.importedGiven({ count, who: scopeName(give, hobs) });
    say({ tone: "done", message }, { _tag: "Overview" });
    void navigate({ to: "/skills", search: {} });
  };

  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 text-detail text-text-secondary">
        {copy.import.found({ count: scan.candidates.length, commit: scan.commit })}
      </p>
      <ImportCandidates
        candidates={scan.candidates}
        picked={picked}
        onToggle={(folder, on) =>
          setPicked((was) => {
            const now = new Set(was);
            if (on) now.add(folder);
            else now.delete(folder);
            return now;
          })
        }
      />
      {exported !== null && (
        <p className="m-0 rounded-card bg-deep px-3.5 py-2.5 text-ui text-text-secondary">
          {copy.import.exportedNote({ when: copy.day(exported.exportedAt), count: exported.assignments })}
        </p>
      )}
      {!keepsAssignments && <GiveChoice value={give} onChange={setGive} active={active} projects={projects} many />}
      {failure !== null && (
        <p role="alert" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={(added === null && folders.length === 0) || writes.busy} onClick={() => void run()}>
          {writes.busy
            ? copy.import.importing
            : added === null
              ? copy.import.importN({ count: folders.length })
              : copy.import.giveAgain}
        </Button>
        <Button asChild variant="quiet">
          <Link to="/skills" search={{}}>
            {copy.import.cancel}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Add a skill: from Git, a folder or a .zip, or written here or by a hob. A source is scanned first, writing nothing. */
export function SkillsImport({
  from,
  active,
  projects,
  hobs,
  say,
}: {
  from: ImportFrom;
  active: ReadonlyArray<Agent>;
  projects: ReadonlyArray<MemoryProjectIdentity>;
  hobs: HobDirectory;
  say: Say;
}) {
  const [source, setSource] = useState<SkillSourcePayload | null>(null);
  const scan = useMutation({ mutationFn: scanSkills });
  const look = (next: SkillSourcePayload) => {
    setSource(next);
    scan.mutate(next);
  };
  const shown = source !== null && scan.isSuccess && (source._tag === "Git" ? from === "git" : from === "file");
  return (
    <div className="flex max-w-[860px] flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="m-0 font-heading text-[26px] leading-8 font-bold text-text-strong">{copy.import.title}</h2>
        <p className="m-0 text-body text-text-secondary">{copy.import.intro}</p>
      </header>
      <SourceTabs from={from} />
      {from === "git" && <GitSource looking={scan.isPending} onLook={look} />}
      {from === "file" && <FileSource looking={scan.isPending} onLook={look} />}
      {from === "write" && <WriteOne />}
      {scan.isError && from !== "write" && (
        <p role="alert" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {copy.import.unreadable}
        </p>
      )}
      {shown && (
        <ScanResult
          key={scan.submittedAt}
          source={source}
          scan={scan.data}
          active={active}
          projects={projects}
          hobs={hobs}
          say={say}
        />
      )}
    </div>
  );
}
