import type { AttemptActivity, FileChange, FileChangeKind } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { formatCount } from "../../../lib/format.ts";
import { ChangeDetail } from "../changes/change-detail.tsx";
import {
  changeCounts,
  changeDir,
  changePath,
  leavesFile,
  selectedChange,
  splitPath,
} from "../changes/changes-model.ts";
import { KindTag } from "../changes/kind-tag.tsx";
import { messages } from "../changes/messages.ts";
import { useLineCounts } from "../changes/use-line-counts.ts";
import { FilePicker } from "../file-picker.tsx";
import { LIST_CARD, listRow } from "../list-row.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const KINDS: ReadonlyArray<FileChangeKind> = ["added", "edited", "deleted", "moved", "link"];

/**
 * The Changes tab (ADR 023): each file the Task added, edited, deleted or moved, with a before and
 * after. Documents are rendered, code is a diff and images sit side by side. While a turn runs the
 * list follows the hub's records as they arrive; afterwards it is the history they kept.
 */
export function ChangesTab({ activity, state, hobs, focus, onTab }: WorkbenchTabProps) {
  // The file to show: one picked in the list by its id, or one a link asked for by its path. A link
  // is kept as asked, so it holds while the records load and after another tab shows.
  const [picked, setPicked] = useState<{ readonly id?: string; readonly path?: string }>(
    focus === undefined ? {} : { path: focus },
  );
  const [asked, setAsked] = useState(focus);
  if (focus !== asked) {
    setAsked(focus);
    if (focus !== undefined) setPicked({ path: focus });
  }
  if (activity === null) return null;
  const changes = activity.changes;
  const live = state.kind === "live";
  if (changes.length === 0) {
    return live ? <p className="m-0 px-5 py-4 text-detail text-label">{messages.noneYet}</p> : null;
  }
  const selected = selectedChange(changes, picked.id ?? null, picked.path);
  const counts = changeCounts(changes);
  const manyFolders = new Set(changes.map((each) => each.folder)).size > 1;
  return (
    <div data-slot="changes" className="flex flex-col gap-3 px-5 py-4">
      <p className="m-0 text-detail text-text-secondary">
        {messages.summary({
          total: changes.length,
          parts: KINDS.filter((kind) => counts[kind] > 0).map((kind) => messages.count[kind](counts[kind])),
        })}
      </p>
      <div className="flex min-w-0 flex-col gap-3.5 @min-[720px]:flex-row @min-[720px]:items-start">
        <FilePicker
          label={messages.files}
          items={changes}
          shown={Math.max(
            0,
            changes.findIndex((each) => each.id === selected?.id),
          )}
          current={
            selected !== null && (
              <>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-strong">
                  {splitPath(selected.path).name}
                </span>
                {/* Very narrow, the name keeps the room; the menu still tags every file. */}
                <span className="hidden @min-[240px]/picker:inline-flex">
                  <KindTag kind={selected.kind} />
                </span>
              </>
            )
          }
          row={(change) => <RowContent change={change} activity={activity} dir={changeDir(change, manyFolders)} />}
          onPick={(index) => {
            const change = changes[index];
            if (change !== undefined) setPicked({ id: change.id });
          }}
        />
        <nav
          aria-label={messages.files}
          className={cn(LIST_CARD, "hidden @min-[720px]:sticky @min-[720px]:top-0 @min-[720px]:flex @min-[720px]:w-58")}
        >
          {changes.map((change) => (
            <button
              key={change.id}
              type="button"
              aria-pressed={change.id === selected?.id}
              onClick={() => setPicked({ id: change.id })}
              className={cn(listRow(change.id === selected?.id), "items-center")}
            >
              <RowContent change={change} activity={activity} dir={changeDir(change, manyFolders)} />
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {selected !== null && (
            <ChangeDetail
              key={selected.id}
              change={selected}
              activity={activity}
              live={live}
              hobs={hobs}
              onOpenFiles={leavesFile(selected) ? () => onTab("files", changePath(selected)) : null}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A changed file as the list and the picker's menu show it: its name, its folder under it, how it
 * changed and, for text, the lines it added and removed.
 */
function RowContent({ change, activity, dir }: { change: FileChange; activity: AttemptActivity; dir: string }) {
  const { name } = splitPath(change.path);
  const counts = useLineCounts(change, activity);
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[13px] leading-[18px] text-text-strong">{name}</span>
        {dir !== "" && <span className="truncate font-mono text-[11px] leading-[15px] text-label">{dir}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-[3px]">
        <KindTag kind={change.kind} />
        {counts !== null && (
          <span className="font-mono text-[11px] leading-[14px] whitespace-nowrap">
            <span aria-hidden>
              <span className="text-mint">+{formatCount(counts.added)}</span>{" "}
              <span className="text-rose">−{formatCount(counts.removed)}</span>
            </span>
            <span className="sr-only">{messages.lines(counts)}</span>
          </span>
        )}
      </span>
    </>
  );
}
