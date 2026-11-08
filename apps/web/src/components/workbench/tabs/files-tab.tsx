import type { AttemptActivity, AttemptId, TaskFile } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { formatBytes } from "../../../lib/format.ts";
import type { HobLookup } from "../../quest/use-work.ts";
import { changePath, leavesFile } from "../changes/changes-model.ts";
import type { DockSource } from "../dock-model.ts";
import { FilePicker } from "../file-picker.tsx";
import { FileActions } from "../files/file-actions.tsx";
import { FilePreview } from "../files/file-preview.tsx";
import { fileName } from "../files/files-model.ts";
import { messages } from "../files/messages.ts";
import { HobBy, HobMark, manyHobs } from "../hob-mark.tsx";
import { LIST_CARD, listRow } from "../list-row.ts";
import { shownDir, shownPath } from "../shown-paths.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

/** A file in the one list, with the Attempt that made or touched it and its Task's source, for its hob. */
interface Entry {
  readonly file: TaskFile;
  readonly activity: AttemptActivity;
  readonly source: DockSource;
}

/** A file's key in the one list: two Attempts can each list the same file. */
const keyOf = (entry: Entry): string => `${entry.activity.attempt.id}/${entry.file.id}`;

/**
 * The Files tab (ADR 023, ADR 027): the files every hob in view made or touched, in one list with
 * each hob's sprite, with previews: Show in Finder in the desktop app on the hub, Download
 * elsewhere. Only files inside the hob's folders are listed. The tree's one read lists them as they
 * are now, and reads them again when you come back to the app.
 */
export function FilesTab({ sources, roots, hobs, focus, from, onTab }: WorkbenchTabProps) {
  const [picked, setPicked] = useState<string | null>(null);
  // A file another tab asks for wins over the one picked here before.
  const [asked, setAsked] = useState(focus);
  if (focus !== asked) {
    setAsked(focus);
    if (focus !== undefined) setPicked(null);
  }
  const entries: ReadonlyArray<Entry> = sources.flatMap((source) =>
    source.files.map(({ file, activity }) => ({ file, activity, source })),
  );
  const made = entries.filter((each) => each.file.origin === "made");
  const touched = entries.filter((each) => each.file.origin !== "made");
  const listed = [...made, ...touched];
  const shown =
    listed.find((each) => keyOf(each) === picked) ??
    (focus === undefined ? undefined : linkedFile(listed, focus, from)) ??
    listed[0];
  if (shown === undefined) return <div data-slot="files" />;
  // Each row shows whose work it is once the list holds more than one hob's.
  const party = manyHobs(sources);
  // Paths read from the Quest's folders, the same on every Task, each led by its folder's name when several (#643).
  const place = (entry: Entry) => shownPath(roots, entry.file.folder, entry.file.path);
  const manyRoots = new Set(listed.map((each) => place(each).root)).size > 1;
  const dirOf = (entry: Entry) => shownDir(place(entry), manyRoots);
  return (
    <div data-slot="files" className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 @min-[720px]:flex-row @min-[720px]:items-start">
        <FilePicker
          label={messages.list}
          items={listed}
          shown={Math.max(0, listed.indexOf(shown))}
          current={
            <>
              {party && <HobMark hob={hobs(shown.source.ownerId)} />}
              <span className="min-w-0 flex-1 truncate font-mono text-code text-text-strong">
                {shown.file.label ?? fileName(shown.file)}
              </span>
            </>
          }
          row={(entry) => <RowContent entry={entry} dir={dirOf(entry)} hobs={hobs} party={party} />}
          onPick={(index) => {
            const entry = listed[index];
            if (entry !== undefined) setPicked(keyOf(entry));
          }}
        />
        <nav
          aria-label={messages.list}
          className={cn(
            LIST_CARD,
            "hidden gap-2 @min-[720px]:sticky @min-[720px]:top-0 @min-[720px]:flex @min-[720px]:w-64",
          )}
        >
          <FileGroup
            title={messages.made}
            entries={made}
            shown={shown}
            dirOf={dirOf}
            hobs={hobs}
            party={party}
            onPick={setPicked}
          />
          <FileGroup
            title={messages.touched}
            entries={touched}
            shown={shown}
            dirOf={dirOf}
            hobs={hobs}
            party={party}
            onPick={setPicked}
          />
        </nav>
        <FileDetail
          key={keyOf(shown)}
          activity={shown.activity}
          file={shown.file}
          onSeeChanges={seeChanges(shown, onTab)}
        />
      </div>
    </div>
  );
}

/** The file a link asks for: the one its try recorded, as two Tasks can touch one path, else any. */
const linkedFile = (listed: ReadonlyArray<Entry>, focus: string, from: AttemptId | undefined): Entry | undefined => {
  const at = listed.filter((each) => each.file.location === focus);
  return at.find((each) => each.activity.attempt.id === from) ?? at[0];
};

function FileGroup({
  title,
  entries,
  shown,
  dirOf,
  hobs,
  party,
  onPick,
}: {
  title: string;
  entries: ReadonlyArray<Entry>;
  shown: Entry;
  dirOf: (entry: Entry) => string;
  hobs: HobLookup;
  party: boolean;
  onPick: (key: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col">
      <h3 className="lbl m-0 px-2 pt-2 pb-1 text-meta font-bold text-label">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {entries.map((entry) => (
          <li key={keyOf(entry)}>
            <button
              type="button"
              aria-pressed={entry === shown}
              onClick={() => onPick(keyOf(entry))}
              className={cn(listRow(entry === shown), "items-center")}
            >
              <RowContent entry={entry} dir={dirOf(entry)} hobs={hobs} party={party} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A file as the list and the picker's menu show it: its hob's sprite in a party's list, its name, where it is and its status note. */
function RowContent({ entry, dir, hobs, party }: { entry: Entry; dir: string; hobs: HobLookup; party: boolean }) {
  const { file } = entry;
  const note = messages.now[file.now];
  const hob = hobs(entry.source.ownerId);
  return (
    <>
      {party && <HobMark hob={hob} />}
      <span className="flex min-w-0 flex-1 flex-col items-start gap-px">
        <span className="w-full truncate font-mono text-code leading-[18px] text-text-strong">
          {file.label ?? fileName(file)}
          {party && <HobBy hob={hob} />}
        </span>
        <span className="w-full truncate text-meta text-label">
          {[messages.origin[file.origin], dir === "" ? null : dir, file.label === null ? null : fileName(file)]
            .filter((part) => part !== null)
            .join(" · ")}
        </span>
        {note !== null && (
          <span className={cn("text-meta font-semibold", file.now === "gone" ? "text-rose" : "text-lantern")}>
            {note}
          </span>
        )}
      </span>
    </>
  );
}

/** Opens the change that left this file in Changes, at the latest try that changed it; null when Changes has none. */
const seeChanges = ({ file, source }: Entry, onTab: WorkbenchTabProps["onTab"]): (() => void) | null => {
  const change = source.changes.find((each) => leavesFile(each.change) && changePath(each.change) === file.location);
  return change === undefined ? null : () => onTab("changes", file.location, change.activity.attempt.id);
};

function FileDetail({
  activity,
  file,
  onSeeChanges,
}: {
  activity: AttemptActivity;
  file: TaskFile;
  onSeeChanges: (() => void) | null;
}) {
  const name = fileName(file);
  const meta = [messages.kind[file.preview], file.size === null ? null : formatBytes(file.size), messages.now[file.now]]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <section
      aria-label={name}
      className="flex min-h-[420px] min-w-0 flex-1 flex-col self-stretch overflow-hidden rounded-card border border-line bg-card"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="m-0 truncate font-mono text-code font-semibold text-text-strong" title={file.location}>
            {name}
          </h3>
          <span className="text-meta text-label">{meta}</span>
        </div>
        {onSeeChanges !== null && (
          <Button variant="ghost" size="xs" onClick={onSeeChanges}>
            {messages.seeChanges}
          </Button>
        )}
        <FileActions attemptId={activity.attempt.id} file={file} name={name} />
      </header>
      <FilePreview attemptId={activity.attempt.id} file={file} />
    </section>
  );
}
