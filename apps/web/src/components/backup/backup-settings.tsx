import type { BackupState } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
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
import { formatMoment } from "../../lib/format.ts";
import { formatBytes } from "../../lib/reply-steps.ts";
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

function Progress({ state }: { state: BackupState }) {
  if (state._tag === "Waiting") {
    return (
      <span role="status" className="text-sm text-lantern">
        {copy.backup.waiting({ turns: state.turns })}
      </span>
    );
  }
  if (state._tag !== "Copying") return null;
  const percent = state.totalBytes === 0 ? 0 : Math.min(100, Math.round((state.copiedBytes / state.totalBytes) * 100));
  return (
    <div className="flex flex-col gap-1">
      <span role="status" className="text-sm">
        {copy.backup.copying[state.step]}{" "}
        <span className="text-text-secondary">
          {copy.backup.progress({ copied: formatBytes(state.copiedBytes), total: formatBytes(state.totalBytes) })}
        </span>
      </span>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={copy.backup.copying[state.step]}
        className="h-2 w-full max-w-[320px] bg-deep"
      >
        <div className="h-2 bg-mint" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Outcome({ state }: { state: BackupState }) {
  if (state._tag === "Done") {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-bold text-mint">
          {copy.backup.done({ when: formatMoment(state.finishedAt), size: formatBytes(state.size) })}
        </span>
        <span className="font-mono text-[13px] break-all text-text-secondary">{state.path}</span>
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

/** Back up now: where to save it, its progress while it runs, and how the last one went. */
function BackupNow() {
  const status = useQuery(backupQuery);
  const start = useStartBackup();
  const cancel = useCancelBackup();
  const [typed, setTyped] = useState<string | null>(null);
  if (status.isError) return <p className="m-0 text-sm text-rose">{copy.failedToRead}</p>;
  if (!status.data) return null;
  const { state, defaultDestination } = status.data;
  const destination = typed ?? defaultDestination;
  const running = backupRunning(state);
  return (
    <div className="cut flex flex-col gap-3 border-2 border-line bg-card px-4 py-3.5">
      <span className="font-bold">{copy.backup.title}</span>
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
      <Progress state={state} />
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
      </div>
      <span className="text-[13px] text-text-secondary">{copy.backup.privacy}</span>
    </div>
  );
}

function WhatItHolds() {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="lbl pt-1 text-xs text-label">{copy.holds.title}</span>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-5 gap-y-1.5 p-0 text-sm sm:grid-cols-2">
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
              ✗{" "}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
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
          className="cut m-0 flex animate-hb-in flex-wrap items-center gap-2 border-2 border-solid border-rose bg-deep px-3 py-2.5"
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
        <div className="cut flex flex-col gap-2.5 border-2 border-line bg-card px-4 py-3.5">
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

/** Settings › Backup & export: Back up now, what a backup holds, and Restore (ADR 026). */
export function BackupSettings() {
  const [restoring, setRestoring] = useState(false);
  return (
    <>
      <p className="m-0 text-text-secondary">{copy.intro}</p>
      <LatestRestore />
      <BackupNow />
      <WhatItHolds />
      {restoring ? (
        <div className="flex flex-col gap-2 pt-2">
          <span className="font-bold">{copy.restore.title}</span>
          <RestoreFlow onCancel={() => setRestoring(false)} />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 pt-2">
          <div>
            <Button variant="outline" onClick={() => setRestoring(true)}>
              {copy.restore.open}
            </Button>
          </div>
          <span className="text-[13px] text-label">{copy.restore.note}</span>
        </div>
      )}
    </>
  );
}
