import type { SkillScan, SkillSourcePayload } from "@hobbots/api";
import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { scanSkills } from "../../api/skills.ts";
import { GiveChoice, type GiveTo } from "./give-choice.tsx";
import { ImportCandidates, ImportRefused } from "./import-candidates.tsx";
import { FileSource, GitSource } from "./import-sources.tsx";
import { messages } from "./messages.ts";
import type { Say } from "./skills-flash.ts";
import { type HobDirectory, type ImportFrom, importable, scopeName, skillsSearchOf } from "./skills-model.ts";
import { SkillsIcon } from "./skills-parts.tsx";
import { useSkillWrites } from "./use-skill-writes.ts";

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
  hobs,
  say,
}: {
  source: SkillSourcePayload;
  scan: SkillScan;
  active: ReadonlyArray<Agent>;
  hobs: HobDirectory;
  say: Say;
}) {
  const navigate = useNavigate();
  const writes = useSkillWrites();
  const can = scan.candidates.filter(importable).map((candidate) => candidate.folder);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(can));
  const [give, setGive] = useState<GiveTo>(null);
  const [failed, setFailed] = useState(false);
  if (scan.candidates.length === 0) return <p className="m-0 text-ui text-text-secondary">{copy.import.none}</p>;
  if (scan.candidates.every((candidate) => candidate.refusal !== null))
    return <ImportRefused candidates={scan.candidates} />;
  const folders = can.filter((folder) => picked.has(folder));

  const run = async () => {
    const added = await writes.add.mutateAsync({ source, folders });
    if (give !== null) {
      for (const one of added.imported) await writes.assign.mutateAsync({ skillId: one.skill.id, scope: give });
    }
    return added.imported.length;
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
      <GiveChoice value={give} onChange={setGive} active={active} many />
      {failed && (
        <p role="alert" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {copy.import.failed}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={folders.length === 0 || writes.busy}
          onClick={() => {
            setFailed(false);
            run()
              .then((count) => {
                const message =
                  give === null
                    ? copy.import.imported({ count })
                    : copy.import.importedGiven({ count, who: scopeName(give, hobs) });
                say({ tone: "done", message }, { _tag: "Overview" });
                void navigate({ to: "/skills", search: {} });
              })
              .catch(() => setFailed(true));
          }}
        >
          {writes.busy ? copy.import.importing : copy.import.importN({ count: folders.length })}
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

/** Add a skill: from Git, a folder or a .zip, or written here. A source is scanned first, writing nothing. */
export function SkillsImport({
  from,
  active,
  hobs,
  say,
}: {
  from: ImportFrom;
  active: ReadonlyArray<Agent>;
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
      {from === "write" && (
        <Link
          to="/skills"
          search={skillsSearchOf({ _tag: "New" })}
          className="flex max-w-[420px] flex-col gap-1 rounded-card border-(length:--edge) border-solid border-line-2 bg-card p-3.5 text-start text-text-strong no-underline hover:border-control"
        >
          <span className="text-body font-semibold">{copy.import.blank}</span>
          <span className="text-detail text-text-secondary">{copy.import.blankHint}</span>
        </Link>
      )}
      {scan.isError && from !== "write" && (
        <p role="alert" className="m-0 rounded-card bg-notice px-3.5 py-2.5 text-ui text-text-strong">
          {copy.import.unreadable}
        </p>
      )}
      {shown && (
        <ScanResult key={scan.submittedAt} source={source} scan={scan.data} active={active} hobs={hobs} say={say} />
      )}
    </div>
  );
}
