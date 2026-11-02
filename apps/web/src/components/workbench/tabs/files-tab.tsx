import type { AttemptActivity, TaskFile, TaskFileId } from "@hobbots/domain";
import { Button, buttonVariants } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { attemptFilesQuery, taskFileUrl } from "../../../api/workbench.ts";
import { formatBytes } from "../../../lib/reply-steps.ts";
import { FilePreview } from "../files/file-preview.tsx";
import { canDownload, fileDirectory, fileName, filesStamp, shownFile } from "../files/files-model.ts";
import { messages } from "../files/messages.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

/**
 * The Files tab (ADR 023): the files the Task made or touched, with previews: Show in Finder in the
 * desktop app on the hub, Download elsewhere. Only files inside the hob's folders are listed.
 */
export function FilesTab(props: WorkbenchTabProps) {
  return (
    <div data-slot="files" className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      {props.activity !== null && <Files activity={props.activity} focus={focusOf(props)} />}
    </div>
  );
}

/** The file another tab asked to show, by where it is on the hub, when the frame passes one. */
const focusOf = (props: WorkbenchTabProps): string | undefined =>
  "focus" in props && typeof props.focus === "string" ? props.focus : undefined;

function Files({ activity, focus }: { activity: AttemptActivity; focus: string | undefined }) {
  const attemptId = activity.attempt.id;
  const stamp = filesStamp(activity);
  const read = useQuery(attemptFilesQuery(attemptId, stamp));
  const [picked, setPicked] = useState<TaskFileId | null>(null);
  if (read.isPending) return <p className="m-0 text-detail text-label">{messages.loading}</p>;
  if (read.isError) {
    return (
      <p className="m-0 flex items-center gap-3 text-detail text-secondary-text">
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
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 md:flex-row">
      <nav
        aria-label={messages.list}
        className="flex shrink-0 flex-col gap-3 bg-panel py-1.5 md:w-[300px] md:overflow-y-auto"
      >
        <FileGroup title={messages.made} files={made} shown={shown} onPick={setPicked} />
        <FileGroup title={messages.touched} files={touched} shown={shown} onPick={setPicked} />
      </nav>
      <FileDetail key={shown.id} activity={activity} file={shown} stamp={stamp} />
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
      <h3 className="m-0 px-3 py-1.5 text-xs font-bold tracking-wide text-label uppercase">{title}</h3>
      <ul className="m-0 flex list-none flex-col p-0">
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
  const folder = fileDirectory(file);
  const note = messages.now[file.now];
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer flex-col items-start gap-0.5 border-0 px-3 py-2 text-left",
        on ? "bg-line" : "bg-transparent hover:bg-hover",
      )}
    >
      <span className="w-full truncate font-mono text-sm text-text">{file.label ?? fileName(file)}</span>
      <span className="w-full truncate text-xs text-secondary-text">
        {[
          messages.origin[file.origin],
          folder === "" ? null : `${folder}/`,
          file.label === null ? null : fileName(file),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </span>
      {note !== null && (
        <span className={cn("text-xs", file.now === "gone" ? "text-rose" : "text-lantern")}>{note}</span>
      )}
    </button>
  );
}

function FileDetail({ activity, file, stamp }: { activity: AttemptActivity; file: TaskFile; stamp: string }) {
  const name = fileName(file);
  const meta = [messages.kind[file.preview], file.size === null ? null : formatBytes(file.size), messages.now[file.now]]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <section aria-label={name} className="flex min-h-[320px] min-w-0 flex-1 flex-col bg-panel">
      <header className="flex flex-wrap items-center gap-2 border-b-2 border-line px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="m-0 truncate font-mono text-sm font-bold text-text" title={file.location}>
            {name}
          </h3>
          <span className="text-xs text-secondary-text">{meta}</span>
        </div>
        <FileActions attemptId={activity.attempt.id} file={file} name={name} />
      </header>
      <FilePreview attemptId={activity.attempt.id} file={file} stamp={stamp} />
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
      href={taskFileUrl(attemptId, file.id, true)}
      download={name}
      aria-label={messages.downloadFor({ name })}
      className={buttonVariants({ variant: "chip", size: "xs", className: "no-underline" })}
    >
      {messages.download}
    </a>
  );
}
