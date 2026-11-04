import type { AttemptActivity, TaskFile, TaskFileId } from "@hobbots/domain";
import { Button, buttonVariants } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { attemptFilesQuery, taskFileUrl } from "../../../api/workbench.ts";
import { formatBytes } from "../../../lib/format.ts";
import { changePath, leavesFile } from "../changes/changes-model.ts";
import { FilePicker } from "../file-picker.tsx";
import { FilePreview } from "../files/file-preview.tsx";
import { canDownload, fileDirectory, fileName, filesStamp, shownFile } from "../files/files-model.ts";
import { messages } from "../files/messages.ts";
import { LIST_CARD, listRow } from "../list-row.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

/**
 * The Files tab (ADR 023): the files the Task made or touched, with previews: Show in Finder in the
 * desktop app on the hub, Download elsewhere. Only files inside the hob's folders are listed.
 */
export function FilesTab(props: WorkbenchTabProps) {
  return (
    <div data-slot="files" className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      {props.activity !== null && (
        <Files activity={props.activity} focus={focusOf(props)} onSeeChanges={(path) => props.onTab("changes", path)} />
      )}
    </div>
  );
}

/** The file another tab asked to show, by where it is on the hub, when the frame passes one. */
const focusOf = (props: WorkbenchTabProps): string | undefined =>
  "focus" in props && typeof props.focus === "string" ? props.focus : undefined;

function Files({
  activity,
  focus,
  onSeeChanges,
}: {
  activity: AttemptActivity;
  focus: string | undefined;
  /** Opens Changes on the file, by where it is on the hub. */
  onSeeChanges: (location: string) => void;
}) {
  const attemptId = activity.attempt.id;
  const stamp = filesStamp(activity);
  const read = useQuery(attemptFilesQuery(attemptId, stamp));
  const [picked, setPicked] = useState<TaskFileId | null>(null);
  // A file another tab asks for wins over the one picked here before.
  const [asked, setAsked] = useState(focus);
  if (focus !== asked) {
    setAsked(focus);
    if (focus !== undefined) setPicked(null);
  }
  if (read.isPending) return <p className="m-0 text-detail text-label">{messages.loading}</p>;
  if (read.isError) {
    return (
      <p className="m-0 flex items-center gap-3 text-detail text-text-secondary">
        <span>{messages.failed}</span>
        <Button variant="chip" size="xs" onClick={() => void read.refetch()}>
          {messages.tryAgain}
        </Button>
      </p>
    );
  }
  const files = read.data.files;
  const shown = shownFile(files, picked, focus);
  if (shown === null) return null;
  const made = files.filter((file) => file.origin === "made");
  const touched = files.filter((file) => file.origin !== "made");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 @min-[720px]:flex-row @min-[720px]:items-start">
      <FilePicker
        label={messages.list}
        items={[...made, ...touched]}
        shown={Math.max(
          0,
          [...made, ...touched].findIndex((file) => file.id === shown.id),
        )}
        current={
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-strong">
            {shown.label ?? fileName(shown)}
          </span>
        }
        currentText={shown.label ?? fileName(shown)}
        row={(file) => (
          <span className="flex min-w-0 flex-col items-start gap-px">
            <RowContent file={file} />
          </span>
        )}
        onPick={(index) => {
          const file = [...made, ...touched][index];
          if (file !== undefined) setPicked(file.id);
        }}
      />
      <nav
        aria-label={messages.list}
        className={cn(
          LIST_CARD,
          "hidden gap-2 @min-[720px]:sticky @min-[720px]:top-0 @min-[720px]:flex @min-[720px]:w-58",
        )}
      >
        <FileGroup title={messages.made} files={made} shown={shown} onPick={setPicked} />
        <FileGroup title={messages.touched} files={touched} shown={shown} onPick={setPicked} />
      </nav>
      <FileDetail
        key={shown.id}
        activity={activity}
        file={shown}
        onSeeChanges={hasChange(activity, shown) ? () => onSeeChanges(shown.location) : null}
      />
    </div>
  );
}

function FileGroup({
  title,
  files,
  shown,
  onPick,
}: {
  title: string;
  files: ReadonlyArray<TaskFile>;
  shown: TaskFile;
  onPick: (id: TaskFileId) => void;
}) {
  if (files.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col">
      <h3 className="lbl m-0 px-2 pt-2 pb-1 text-xs font-bold text-label">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {files.map((file) => (
          <li key={file.id}>
            <FileRow file={file} on={file.id === shown.id} onPick={() => onPick(file.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FileRow({ file, on, onPick }: { file: TaskFile; on: boolean; onPick: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onPick} className={cn(listRow(on), "flex-col items-start gap-px")}>
      <RowContent file={file} />
    </button>
  );
}

/** A file as the list and the picker's menu show it: its name, where it is and its status note. */
function RowContent({ file }: { file: TaskFile }) {
  const folder = fileDirectory(file);
  const note = messages.now[file.now];
  return (
    <>
      <span className="w-full truncate font-mono text-[13px] leading-[18px] text-text-strong">
        {file.label ?? fileName(file)}
      </span>
      <span className="w-full truncate text-xs text-label">
        {[
          messages.origin[file.origin],
          folder === "" ? null : `${folder}/`,
          file.label === null ? null : fileName(file),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </span>
      {note !== null && (
        <span className={cn("text-xs font-semibold", file.now === "gone" ? "text-rose" : "text-lantern")}>{note}</span>
      )}
    </>
  );
}

/** Whether Changes has a change that left this file, so See changes can open it there. */
const hasChange = (activity: AttemptActivity, file: TaskFile): boolean =>
  activity.changes.some((change) => leavesFile(change) && changePath(change) === file.location);

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
          <h3
            className="m-0 truncate font-mono text-[13.5px] leading-5 font-semibold text-text-strong"
            title={file.location}
          >
            {name}
          </h3>
          <span className="text-xs text-label">{meta}</span>
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

/**
 * Show in Finder in the desktop app, which runs on the hub; Download through the hub in a browser
 * or on another device. A file no longer there offers neither.
 */
function FileActions({
  attemptId,
  file,
  name,
}: {
  attemptId: AttemptActivity["attempt"]["id"];
  file: TaskFile;
  name: string;
}) {
  const showFile = window.hobbots?.showFile;
  const [missed, setMissed] = useState(false);
  if (file.now === "gone") return null;
  if (showFile !== undefined) {
    return (
      <span className="flex items-center gap-2">
        {missed && <span className="text-xs text-lantern">{messages.notShown}</span>}
        <Button
          variant="chip"
          size="xs"
          aria-label={messages.showInFinderFor({ name })}
          onClick={() => void showFile(attemptId, file.id).then((shown) => setMissed(!shown))}
        >
          {messages.showInFinder}
        </Button>
      </span>
    );
  }
  if (!canDownload(file)) return null;
  return (
    <a
      href={taskFileUrl(attemptId, file.id, { download: true, version: file.hash })}
      download={name}
      aria-label={messages.downloadFor({ name })}
      className={buttonVariants({ variant: "chip", size: "xs", className: "no-underline" })}
    >
      {messages.download}
    </a>
  );
}
