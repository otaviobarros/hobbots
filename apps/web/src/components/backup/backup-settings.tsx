import type { BackupState } from "@hobbots/api";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Progress } from "@hobbots/ui/components/progress";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  backupQuery,
  backupRunning,
  restoreStatusQuery,
  useCancelBackup,
  useDeleteSetAside,
  useResumeWork,
  useStartBackup,
} from "../../api/backup.ts";
import { ApiError } from "../../api/client.ts";
import { formatAgo, formatBytes, formatMoment } from "../../lib/format.ts";
import { ExportSettings } from "../export/export-settings.tsx";
import { messages as exportMessages } from "../export/messages.ts";
import { FolderField } from "./folder-field.tsx";
import { messages } from "./messages.ts";
import { RestoreFlow } from "./restore-flow.tsx";

const copy = messages;

/** The words of a refusal: the hub's reason or message when it gave one. */
const refusal = (error: Error | null) => {
  if (!(error instanceof ApiError)) return error?.message ?? "";
  const { reason, message } = error.fields;
  return typeof reason === "string" ? reason : typeof message === "string" ? message : error.message;
};

function BackupProgress({ state }: { state: BackupState }) {
  if (state._tag === "Waiting") {
    return (
      <span role="status" className="text-sm text-lantern">
        {copy.backup.waiting({ turns: state.turns })}
      </span>
    );
  }
  if (state._tag !== "Copying") return null;
  return (
    <div className="flex flex-col gap-1">
      <span role="status" className="text-sm">
        {copy.backup.copying[state.step]}{" "}
        <span className="text-text-secondary">
          {copy.backup.progress({ copied: formatBytes(state.copiedBytes), total: formatBytes(state.totalBytes) })}
        </span>
      </span>
      <Progress
        value={state.copiedBytes}
        max={state.totalBytes}
        aria-label={copy.backup.copying[state.step]}
        className="max-w-[320px]"
      />
    </div>
  );
}

/** Where the last backup went, or why it did not finish. */
function Outcome({ state }: { state: BackupState }) {
  if (state._tag === "Done") {
    return (
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="text-text-secondary">{copy.backup.saved({ size: formatBytes(state.size) })}</span>
        <span className="font-mono text-detail break-all text-text">{state.path}</span>
      </div>
    );
  }
  if (state._tag === "Failed") {
    return (
      <span role="alert" className="text-sm text-rose">
        {copy.backup.failed({ reason: state.reason })}
      </span>
    );
  }
  return null;
}

/** The tag beside Backups: never backed up, backing up, when the last one finished, or that it failed. */
function BackupTag({ state }: { state: BackupState }) {
  switch (state._tag) {
    case "Waiting":
    case "Copying":
      return <Badge variant="running">{copy.tag.running}</Badge>;
    case "Done":
      return (
        <Badge variant="done">
          <span aria-hidden data-slot="badge-glyph">
            ✓
          </span>
          {copy.tag.done({ when: formatAgo(state.finishedAt) })}
        </Badge>
      );
    case "Failed":
      return <Badge variant="failed">{copy.tag.failed}</Badge>;
    default:
      return <Badge variant="muted">{copy.tag.idle}</Badge>;
  }
}

function WhatItHolds() {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-text-secondary hover:text-text-strong">{copy.holds.title}</summary>
      <ul className="m-0 mt-2 grid list-none grid-cols-1 gap-x-5 gap-y-1.5 p-0 sm:grid-cols-2">
        {copy.holds.kept.map((item) => (
          <li key={item}>
            <span aria-hidden className="text-mint">
              ✓{" "}
            </span>
            {item}
          </li>
        ))}
        {copy.holds.left.map((item) => (
          <li key={item}>
            <span aria-hidden className="text-rose">
              ✕{" "}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Resume work after a restore, here and in the held-work notice. */
export function ResumeWorkButton() {
  const resume = useResumeWork();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={resume.isPending} onClick={() => resume.mutate()}>
        {resume.isPending ? copy.latest.resuming : copy.latest.resume}
      </Button>
      {resume.isError && (
        <span role="alert" className="text-sm text-rose">
          {copy.latest.resumeFailed}
        </span>
      )}
    </span>
  );
}

function SetAside({ path, size }: { path: string; size: number }) {
  const [asking, setAsking] = useState(false);
  const remove = useDeleteSetAside();
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>{copy.latest.setAside({ size: formatBytes(size) })}</span>
          <span className="font-mono text-[13px] break-all text-text-secondary">{path}</span>
        </span>
        {!asking && (
          <Button variant="deny" size="xs" onClick={() => setAsking(true)}>
            {copy.latest.delete}
          </Button>
        )}
      </span>
      {asking && (
        <fieldset
          disabled={remove.isPending}
          aria-label={copy.latest.deleteConfirm}
          className="m-0 flex animate-hb-in flex-wrap items-center gap-2 rounded-control border-0 bg-rose/18 px-3 py-2.5"
        >
          <span className="flex-1 text-rose">{copy.latest.deleteConfirm}</span>
          <Button variant="outline" size="sm" onClick={() => setAsking(false)}>
            {copy.latest.keep}
          </Button>
          <Button variant="deny" size="sm" onClick={() => remove.mutate()}>
            {remove.isPending ? copy.latest.deleting : copy.latest.confirmDelete}
          </Button>
        </fieldset>
      )}
    </div>
  );
}

/** What the latest restore left: work held until you resume it, folders to set again, and the data set aside. */
function LatestRestore() {
  const status = useQuery(restoreStatusQuery);
  if (!status.data) return null;
  const { latest, failed } = status.data;
  return (
    <>
      {failed !== null && (
        <p role="alert" className="m-0 text-sm text-rose">
          {copy.latest.lastFailed({ reason: failed })}
        </p>
      )}
      {latest !== null && (
        <div className="flex flex-col gap-2.5 rounded-control bg-panel px-3.5 py-3">
          <span className="text-sm">
            {copy.latest.restored({ when: formatMoment(latest.restoredAt), made: formatMoment(latest.backupMadeAt) })}
          </span>
          {latest.workHeld && (
            <div className="flex flex-col gap-1.5">
              <span className="font-bold text-lantern">{copy.latest.held}</span>
              <span className="text-sm text-text-secondary">{copy.latest.heldNote}</span>
              <ResumeWorkButton />
            </div>
          )}
          {latest.missingFolders.length > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              <span>{copy.latest.missing}</span>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {latest.missingFolders.map((folder) => (
                  <li key={folder} className="font-mono text-[13px] break-all text-text-secondary">
                    {folder}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {latest.setAside !== null && <SetAside path={latest.setAside.path} size={latest.setAside.size} />}
        </div>
      )}
    </>
  );
}

type Open = "restore" | "export" | null;

/**
 * Settings › Your data › Backups, one card: how the last backup went, where to save the next, Back
 * up now, Restore from a backup and Export as files (ADR 026).
 */
export function BackupSettings() {
  const status = useQuery(backupQuery);
  const start = useStartBackup();
  const cancel = useCancelBackup();
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const toggle = (next: Exclude<Open, null>) => setOpen((now) => (now === next ? null : next));
  if (status.isError) return <p className="m-0 text-sm text-rose">{copy.failedToRead}</p>;
  if (!status.data) return null;
  const { state, defaultDestination } = status.data;
  const destination = typed ?? defaultDestination;
  const running = backupRunning(state);
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-3 rounded-card bg-card p-4">
      <span className="flex flex-wrap items-center gap-2.5">
        <strong className="flex-1 text-text-strong">{copy.heading}</strong>
        <BackupTag state={state} />
      </span>
      <span className="text-sm text-text-secondary">{copy.intro}</span>
      <LatestRestore />
      <FolderField
        label={copy.backup.destination}
        hint={copy.backup.destinationHint}
        chooseLabel={copy.backup.choose}
        purpose="save"
        value={destination}
        disabled={running || start.isPending}
        onChange={(next) => {
          setTyped(next);
          start.reset();
        }}
      />
      <BackupProgress state={state} />
      {!running && <Outcome state={state} />}
      {start.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {refusal(start.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {copy.backup.cancel}
          </Button>
        ) : (
          <Button
            disabled={start.isPending || destination.trim() === ""}
            onClick={() => start.mutate(destination.trim())}
          >
            {start.isPending ? copy.backup.starting : copy.backup.start}
          </Button>
        )}
        <Button variant="outline" aria-expanded={open === "restore"} onClick={() => toggle("restore")}>
          {copy.restore.open}
        </Button>
        <Button variant="ghost" aria-expanded={open === "export"} onClick={() => toggle("export")}>
          {copy.exportOpen}
        </Button>
      </div>
      <span className="text-detail text-text-secondary">{copy.backup.privacy}</span>
      <WhatItHolds />
      {open === "restore" && (
        <div className="flex flex-col gap-2 rounded-control bg-panel p-3.5">
          <span className="font-bold text-text-strong">{copy.restore.title}</span>
          <span className="text-detail text-label">{copy.restore.note}</span>
          <RestoreFlow onCancel={() => setOpen(null)} />
        </div>
      )}
      {open === "export" && (
        <section aria-label={exportMessages.heading} className="flex flex-col gap-3 rounded-control bg-panel p-3.5">
          <span className="font-bold text-text-strong">{exportMessages.heading}</span>
          <ExportSettings />
        </section>
      )}
    </section>
  );
}
