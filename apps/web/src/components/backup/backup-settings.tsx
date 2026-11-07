import type { BackupState, RestoreStatus } from "@hobbots/api";
import { memoryScopeKey } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Progress } from "@hobbots/ui/components/progress";
import { Skeleton } from "@hobbots/ui/components/skeleton";
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
import { chooseBackupFolder, useBackupFolder } from "../../api/backup-folder.ts";
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
      <span role="status" className="text-ui text-lantern">
        {copy.backup.waiting({ turns: state.turns })}
      </span>
    );
  }
  if (state._tag !== "Copying") return null;
  return (
    <div className="flex flex-col gap-1">
      <span role="status" className="text-ui">
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
      <div className="flex min-w-0 flex-col gap-0.5 text-ui">
        <span className="text-text-secondary">{copy.backup.saved({ size: formatBytes(state.size) })}</span>
        <span className="font-mono text-code break-all text-text">{state.path}</span>
      </div>
    );
  }
  if (state._tag === "Failed") {
    return (
      <span role="alert" className="text-ui text-rose">
        {copy.backup.failed({ reason: state.reason })}
      </span>
    );
  }
  return null;
}

/** The tag beside Backups: never backed up, backing up, when the last one finished, or that it failed. */
/** The card's tag: a still block until the hub says how the last backup went. */
function BackupTag({ state }: { state: BackupState | undefined }) {
  if (state === undefined) return <Skeleton shape="block" surface="card" width="14ch" />;
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
    <details className="text-ui">
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
        <span role="alert" className="text-ui text-rose">
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
    <div className="flex flex-col gap-1.5 text-ui">
      <span className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>{copy.latest.setAside({ size: formatBytes(size) })}</span>
          <span className="font-mono text-code break-all text-text-secondary">{path}</span>
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

type SkillMove = NonNullable<RestoreStatus["latest"]>["skillMoves"][number];

/** Who a moved assignment was for: Everyone, a project, or the hob by name. */
const movedWho = (move: SkillMove) => {
  switch (move.scope._tag) {
    case "Everyone":
      return copy.latest.everyone;
    case "Project":
      return copy.latest.project({
        name: move.scope.identity.split("/").filter(Boolean).at(-1) ?? move.scope.identity,
      });
    case "Hob":
      return move.hob ?? copy.latest.formerHob;
  }
};

/**
 * What the latest restore left: work held until you resume it, folders to set again, skills from
 * `~/.agents/skills` that are not on this computer or moved to its revision now, and the data set aside.
 */
function LatestRestore({ status }: { status: RestoreStatus }) {
  const { latest, failed } = status;
  return (
    <>
      {failed !== null && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.latest.lastFailed({ reason: failed })}
        </p>
      )}
      {latest !== null && (
        <div className="flex flex-col gap-2.5 rounded-control bg-panel px-3.5 py-3">
          <span className="text-ui">
            {copy.latest.restored({ when: formatMoment(latest.restoredAt), made: formatMoment(latest.backupMadeAt) })}
          </span>
          {latest.workHeld && (
            <div className="flex flex-col gap-1.5">
              <span className="font-bold text-lantern">{copy.latest.held}</span>
              <span className="text-ui text-text-secondary">{copy.latest.heldNote}</span>
              <ResumeWorkButton />
            </div>
          )}
          {latest.missingFolders.length > 0 && (
            <div className="flex flex-col gap-1 text-ui">
              <span>{copy.latest.missing}</span>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {latest.missingFolders.map((folder) => (
                  <li key={folder} className="font-mono text-code break-all text-text-secondary">
                    {folder}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {latest.skillsNotHere.length > 0 && (
            <div className="flex flex-col gap-1 text-ui">
              <span>{copy.latest.skillsNotHere}</span>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {latest.skillsNotHere.map((name) => (
                  <li key={name} className="font-mono text-code break-all text-text-secondary">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {latest.skillMoves.length > 0 && (
            <div className="flex flex-col gap-1 text-ui">
              <span>{copy.latest.skillMoves}</span>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {latest.skillMoves.map((move) => (
                  <li key={`${move.skill}:${memoryScopeKey(move.scope)}`} className="text-text-secondary">
                    {copy.latest.skillMove({ skill: move.skill, who: movedWho(move) })}
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

/** A backup on its way, or how the last one went. */
function BackupNow({ state }: { state: BackupState }) {
  return (
    <>
      <BackupProgress state={state} />
      {!backupRunning(state) && <Outcome state={state} />}
    </>
  );
}

/** Back up now, or Cancel while a backup runs. Back up now waits until the hub has answered. */
function BackupAction({
  running,
  ready,
  destination,
  start,
  cancel,
}: {
  running: boolean;
  ready: boolean;
  destination: string;
  start: ReturnType<typeof useStartBackup>;
  cancel: ReturnType<typeof useCancelBackup>;
}) {
  if (running) {
    return (
      <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
        {copy.backup.cancel}
      </Button>
    );
  }
  return (
    <Button
      disabled={!ready || start.isPending || destination.trim() === ""}
      onClick={() => start.mutate(destination.trim())}
    >
      {start.isPending ? copy.backup.starting : copy.backup.start}
    </Button>
  );
}

type Open = "restore" | "export" | null;

/**
 * Settings › Your data › Backups, one card: how the last backup went, where to save the next, Back
 * up now, Restore from a backup and Export as files (ADR 026). The card draws at once: until the hub
 * answers, a still block holds the tag and the buttons wait, disabled.
 */
export function BackupSettings() {
  const status = useQuery(backupQuery);
  const restore = useQuery(restoreStatusQuery);
  const start = useStartBackup();
  const cancel = useCancelBackup();
  const [open, setOpen] = useState<Open>(null);
  const destination = useBackupFolder(status.data?.defaultDestination);
  const toggle = (next: Exclude<Open, null>) => setOpen((now) => (now === next ? null : next));
  if (status.isError) return <p className="m-0 text-ui text-rose">{copy.failedToRead}</p>;
  const state = status.data?.state;
  const loading = state === undefined || restore.isPending;
  const running = state !== undefined && backupRunning(state);
  return (
    <section aria-label={copy.heading} aria-busy={loading} className="flex flex-col gap-3 rounded-card bg-card p-4">
      <span className="flex flex-wrap items-center gap-2.5">
        <strong className="flex-1 text-text-strong">{copy.heading}</strong>
        <BackupTag state={state} />
      </span>
      <span className="text-ui text-text-secondary">{copy.intro}</span>
      {restore.data && <LatestRestore status={restore.data} />}
      <FolderField
        label={copy.backup.destination}
        hint={copy.backup.destinationHint}
        chooseLabel={copy.backup.choose}
        purpose="save"
        value={destination}
        disabled={loading || running || start.isPending}
        onChange={(next) => {
          chooseBackupFolder(next);
          start.reset();
        }}
      />
      {state !== undefined && <BackupNow state={state} />}
      {start.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {refusal(start.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <BackupAction running={running} ready={!loading} destination={destination} start={start} cancel={cancel} />
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
