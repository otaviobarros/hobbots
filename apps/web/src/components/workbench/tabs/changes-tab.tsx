import { type FileChange, type FileChangeKind, isLiveAttempt } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { formatCount } from "../../../lib/format.ts";
import type { HobLookup } from "../../quest/use-work.ts";
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
import type { DockSource } from "../dock-model.ts";
import { FilePicker } from "../file-picker.tsx";
import { HobBy, HobMark, manyHobs } from "../hob-mark.tsx";
import { LIST_CARD, listRow } from "../list-row.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const KINDS: ReadonlyArray<FileChangeKind> = ["added", "edited", "deleted", "moved", "link"];

/** A change in the one list, with the Attempt it was made in and the hob it is for. */
interface Entry {
  readonly change: FileChange;
  readonly source: DockSource;
}

/**
 * The Changes tab (ADR 023, ADR 027): each file every hob in view added, edited, deleted or moved, in
 * one list with its hob's sprite, each with a before and after. Documents are rendered, code is a
 * diff and images sit side by side. While a turn runs the list follows the hub's records as they
 * arrive; afterwards it is the history they kept.
 */
export function ChangesTab({ sources, state, hobs, focus, onTab }: WorkbenchTabProps) {
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
  const entries: ReadonlyArray<Entry> = sources.flatMap((source) =>
    source.activity.changes.map((change) => ({ change, source })),
  );
  const changes = entries.map((each) => each.change);
  if (changes.length === 0) {
    return state.kind === "live" ? <p className="m-0 px-5 py-4 text-detail text-label">{messages.noneYet}</p> : null;
  }
  const selected = selectedChange(changes, picked.id ?? null, picked.path);
  const shown = entries.find((each) => each.change.id === selected?.id);
  const counts = changeCounts(changes);
  const manyFolders = new Set(changes.map((each) => each.folder)).size > 1;
  // Each row shows whose work it is once the list holds more than one hob's.
  const party = manyHobs(sources);
  const row = (entry: Entry) => (
    <RowContent entry={entry} hobs={hobs} party={party} dir={changeDir(entry.change, manyFolders)} />
  );
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
          items={entries}
          shown={shown === undefined ? 0 : Math.max(0, entries.indexOf(shown))}
          current={shown !== undefined && <Current entry={shown} hobs={hobs} party={party} />}
          row={row}
          onPick={(index) => {
            const change = changes[index];
            if (change !== undefined) setPicked({ id: change.id });
          }}
        />
        <nav
          aria-label={messages.files}
          className={cn(LIST_CARD, "hidden @min-[720px]:sticky @min-[720px]:top-0 @min-[720px]:flex @min-[720px]:w-64")}
        >
          {entries.map((entry) => (
            <button
              key={entry.change.id}
              type="button"
              aria-pressed={entry.change.id === shown?.change.id}
              onClick={() => setPicked({ id: entry.change.id })}
              className={cn(listRow(entry.change.id === shown?.change.id), "items-center")}
            >
              {row(entry)}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {shown !== undefined && (
            <ChangeDetail
              key={shown.change.id}
              change={shown.change}
              activity={shown.source.activity}
              live={isLiveAttempt(shown.source.attempt.state)}
              hobs={hobs}
              onOpenFiles={leavesFile(shown.change) ? () => onTab("files", changePath(shown.change)) : null}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The file shown, as the folded list's line names it: its hob, its name and how it changed. */
function Current({ entry, hobs, party }: { entry: Entry; hobs: HobLookup; party: boolean }) {
  return (
    <>
      {party && <HobMark hob={hobs(entry.source.ownerId)} />}
      <span className="min-w-0 flex-1 truncate font-mono text-code text-text-strong">
        {splitPath(entry.change.path).name}
      </span>
      {/* Very narrow, the name keeps the room; the menu still tags every file. */}
      <span className="hidden @min-[240px]/picker:inline-flex">
        <KindTag kind={entry.change.kind} />
      </span>
    </>
  );
}

/**
 * A changed file as the list and the picker's menu show it: the sprite of the hob that changed it in
 * a party's list, its name with its folder under it, how it changed and, for text, the lines it
 * added and removed.
 */
function RowContent({ entry, hobs, party, dir }: { entry: Entry; hobs: HobLookup; party: boolean; dir: string }) {
  const { change, source } = entry;
  const { name } = splitPath(change.path);
  const counts = useLineCounts(change, source.activity);
  const hob = hobs(source.ownerId);
  return (
    <>
      {party && <HobMark hob={hob} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-code leading-[18px] text-text-strong">
          {name}
          {party && <HobBy hob={hob} />}
        </span>
        {dir !== "" && <span className="truncate font-mono text-meta text-label">{dir}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-[3px]">
        <KindTag kind={change.kind} />
        {counts !== null && (
          <span className="font-mono text-meta whitespace-nowrap">
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
