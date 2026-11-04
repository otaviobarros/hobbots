import type { ArtifactRef } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { messages } from "../messages.ts";
import type { WorkbenchTab } from "../workbench-model.ts";
import type { Summary } from "./summary-model.ts";

const copy = messages.summary;

/** Changed files listed before the rest fold into one link to Changes. */
const CHANGES_SHOWN = 6;

/** The Task's Artifact references and the Attempt's changed files, each linked into Files or Changes. */
export function Made({
  summary,
  owner,
  running,
  reading,
  onTab,
}: {
  summary: Summary;
  owner: string;
  running: boolean;
  reading: boolean;
  onTab: (tab: WorkbenchTab, focus?: string) => void;
}) {
  const { artifacts, changes } = summary.made;
  if (artifacts.length === 0 && changes.length === 0) {
    if (reading) return <Empty>{copy.readingChanges}</Empty>;
    return <Empty>{running ? copy.madeSoFar({ name: owner }) : copy.nothingMade({ name: owner })}</Empty>;
  }
  const shown = changes.slice(0, CHANGES_SHOWN);
  return (
    <div className="flex flex-col gap-2">
      {artifacts.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <Artifact artifact={artifact} onTab={onTab} />
            </li>
          ))}
        </ul>
      )}
      {changes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map(({ change, path }) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => onTab("changes", path)}
                aria-label={copy.seeChange({ path: change.path })}
                className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-2.5 py-1 text-start text-detail text-text-strong hover:bg-hover"
              >
                <span className="w-16 shrink-0 text-meta font-bold text-label">{copy.change[change.kind]}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                {change.movedFrom !== null && (
                  <span className="min-w-0 truncate text-meta text-label">
                    {copy.movedFrom({ path: change.movedFrom })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {changes.length > shown.length && (
        <Button variant="text" size="xs" className="self-start" onClick={() => onTab("changes")}>
          {copy.moreChanges({ count: changes.length - shown.length })}
        </Button>
      )}
    </div>
  );
}

function Artifact({ artifact, onTab }: { artifact: ArtifactRef; onTab: (tab: WorkbenchTab, focus?: string) => void }) {
  const box = "flex flex-col gap-0.5 border-(length:--edge) border-line bg-card px-3 py-2 text-detail";
  if (artifact.kind === "file") {
    return (
      <button
        type="button"
        onClick={() => onTab("files", artifact.value)}
        aria-label={copy.seeFile({ label: artifact.label })}
        className={cn(box, "w-full cursor-pointer text-start text-text-strong hover:bg-hover")}
      >
        <span className="font-bold">{artifact.label}</span>
        <span className="font-mono break-all text-text-secondary">{artifact.value}</span>
      </button>
    );
  }
  return (
    <div className={box}>
      <span className="font-bold">{artifact.label}</span>
      {artifact.kind === "link" ? (
        <a href={artifact.value} target="_blank" rel="noreferrer" className="break-all text-link">
          {artifact.value}
        </a>
      ) : (
        <span className="whitespace-pre-wrap">{artifact.value}</span>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-detail text-text-secondary">{children}</p>;
}
