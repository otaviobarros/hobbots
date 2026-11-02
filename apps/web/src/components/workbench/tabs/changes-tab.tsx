import type { FileChange, FileChangeKind } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { ChangeDetail } from "../changes/change-detail.tsx";
import { byFolder, changeCounts, selectedChange, splitPath } from "../changes/changes-model.ts";
import { KindTag } from "../changes/kind-tag.tsx";
import { messages } from "../changes/messages.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const KINDS: ReadonlyArray<FileChangeKind> = ["added", "edited", "deleted", "moved", "link"];

/**
 * The Changes tab (ADR 023): each file the Task added, edited, deleted or moved, with a before and
 * after. Documents are rendered, code is a diff and images sit side by side. While a turn runs the
 * list follows the hub's records as they arrive; afterwards it is the history they kept.
 */
export function ChangesTab({ activity, state, hobs }: WorkbenchTabProps) {
  const [picked, setPicked] = useState<string | null>(null);
  if (activity === null) return null;
  const changes = activity.changes;
  const live = state.kind === "live";
  if (changes.length === 0) {
    return live ? <p className="m-0 px-5 py-4 text-detail text-label">{messages.noneYet}</p> : null;
  }
  const selected = selectedChange(changes, picked, undefined);
  const counts = changeCounts(changes);
  const folders = byFolder(changes);
  return (
    <div data-slot="changes" className="@container flex flex-col gap-3 px-5 py-4">
      <p className="m-0 text-detail text-secondary-text">
        {messages.summary({
          total: changes.length,
          parts: KINDS.filter((kind) => counts[kind] > 0).map((kind) => messages.count[kind](counts[kind])),
        })}
      </p>
      <div className="flex min-w-0 flex-col gap-4 @3xl:flex-row @3xl:items-start">
        <nav aria-label={messages.files} className="cut flex shrink-0 flex-col bg-panel py-1.5 @3xl:w-72">
          {folders.map(({ folder, changes: inFolder }) => (
            <div key={folder} className="flex flex-col">
              {folders.length > 1 && (
                <span className="truncate px-3 pt-2 pb-1 font-mono text-meta text-label" title={folder}>
                  {folder}
                </span>
              )}
              <ul className="m-0 flex list-none flex-col p-0">
                {inFolder.map((change) => (
                  <li key={change.id}>
                    <FileRow change={change} on={change.id === selected?.id} onPick={() => setPicked(change.id)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {selected !== null && (
            <ChangeDetail key={selected.id} change={selected} activity={activity} live={live} hobs={hobs} />
          )}
        </div>
      </div>
    </div>
  );
}

/** A changed file in the list: its name first, then its folder inside the hob's, and how it changed. */
function FileRow({ change, on, onPick }: { change: FileChange; on: boolean; onPick: () => void }) {
  const { dir, name } = splitPath(change.path);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 border-0 px-3 py-1.5 text-start",
        on ? "bg-line text-moonlight" : "bg-transparent text-text hover:bg-hover",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-detail">{name}</span>
        {dir !== "" && <span className="truncate font-mono text-meta text-label">{dir}</span>}
      </span>
      <KindTag kind={change.kind} />
    </button>
  );
}
