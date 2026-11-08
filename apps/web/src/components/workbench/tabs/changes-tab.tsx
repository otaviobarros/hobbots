import { type FileChangeKind, isLiveAttempt } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { formatCount } from "../../../lib/format.ts";
import type { HobLookup } from "../../quest/use-work.ts";
import { ChangeDetail } from "../changes/change-detail.tsx";
import { changeCounts, changePath, leavesFile, selectedChange, splitPath } from "../changes/changes-model.ts";
import { KindTag } from "../changes/kind-tag.tsx";
import { messages } from "../changes/messages.ts";
import type { TaskChange } from "../changes/task-changes.ts";
import { useLineCounts } from "../changes/use-line-counts.ts";
import type { DockSource } from "../dock-model.ts";
import { FilePicker } from "../file-picker.tsx";
import { HobBy, HobMark, manyHobs } from "../hob-mark.tsx";
import { LIST_CARD, listRow } from "../list-row.ts";
import { shownDir, shownPath } from "../shown-paths.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const KINDS: ReadonlyArray<FileChangeKind> = ["added", "edited", "deleted", "moved", "link"];

/** A file in the one list, as its Task's tries left it, with the Task's shown try and the hob it is for. */
interface Entry {
  readonly item: TaskChange;
  readonly source: DockSource;
}

/**
 * The Changes tab (ADR 023, ADR 027): each file every hob in view added, edited, deleted or moved, in
 * one list with its hob's sprite, each with a before and after. Documents are rendered, code is a
 * diff and images sit side by side. A Task's tries up to the one shown count as one, so a retry
 * shows what the tries it followed left too (#1218). Paths read from the Quest's folders, the same
 * on every Task (#643). While a turn runs the list follows the hub's records as they arrive;
 * afterwards it is the history they kept.
 */
export function ChangesTab({ sources, roots, state, hobs, focus, from, onTab }: WorkbenchTabProps) {
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
  const entries: ReadonlyArray<Entry> = sources.flatMap((source) => source.changes.map((item) => ({ item, source })));
  const changes = entries.map((each) => each.item.change);
  if (changes.length === 0) {
    return state.kind === "live" ? <p className="m-0 px-5 py-4 text-detail text-label">{messages.noneYet}</p> : null;
  }
  // A link from another tab names the try that recorded its file, as two Tasks can change one path.
  const recorded =
    from === undefined
      ? []
      : entries.filter((each) => each.item.attempts.some((one) => one.id === from)).map((each) => each.item.change);
  const selected = selectedChange(
    recorded.some((each) => changePath(each) === picked.path) ? recorded : changes,
    picked.id ?? null,
    picked.path,
  );
  const shown = entries.find((each) => each.item.change.id === selected?.id);
  const counts = changeCounts(changes);
  const place = (entry: Entry) => shownPath(roots, entry.item.change.folder, entry.item.change.path);
  const manyRoots = new Set(entries.map((each) => place(each).root)).size > 1;
  // Each row shows whose work it is once the list holds more than one hob's.
  const party = manyHobs(sources);
  const row = (entry: Entry) => (
    <RowContent entry={entry} hobs={hobs} party={party} dir={shownDir(place(entry), manyRoots)} />
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
              key={entry.item.change.id}
              type="button"
              aria-pressed={entry === shown}
              onClick={() => setPicked({ id: entry.item.change.id })}
              className={cn(listRow(entry === shown), "items-center")}
            >
              {row(entry)}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {shown !== undefined && (
            <ChangeDetail
              key={shown.item.change.id}
              item={shown.item}
              place={{
                path: place(shown).path,
                dir: shownDir(place(shown), false),
                movedFrom:
                  shown.item.change.movedFrom === null
                    ? null
                    : shownPath(roots, shown.item.change.folder, shown.item.change.movedFrom).path,
              }}
              shownTry={shown.source.attempt}
              live={isLiveAttempt(shown.source.attempt.state)}
              hobs={hobs}
              onOpenFiles={openInFiles(shown, onTab)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Opens the file a change left in Files, at the try that lists it; null when it left none there. */
const openInFiles = ({ item, source }: Entry, onTab: WorkbenchTabProps["onTab"]): (() => void) | null => {
  const at = changePath(item.change);
  const listed = source.files.find((each) => each.file.location === at);
  return leavesFile(item.change) && listed !== undefined ? () => onTab("files", at, listed.activity.attempt.id) : null;
};

/** The file shown, as the folded list's line names it: its hob, its name and how it changed. */
function Current({ entry, hobs, party }: { entry: Entry; hobs: HobLookup; party: boolean }) {
  return (
    <>
      {party && <HobMark hob={hobs(entry.source.ownerId)} />}
      <span className="min-w-0 flex-1 truncate font-mono text-code text-text-strong">
        {splitPath(entry.item.change.path).name}
      </span>
      {/* Very narrow, the name keeps the room; the menu still tags every file. */}
      <span className="hidden @min-[240px]/picker:inline-flex">
        <KindTag kind={entry.item.change.kind} />
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
  const { item, source } = entry;
  const { change } = item;
  const { name } = splitPath(change.path);
  const counts = useLineCounts(item);
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
