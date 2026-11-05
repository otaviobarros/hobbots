import type { BackupState } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@hobbots/ui/components/dialog";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useActivity } from "../../api/activity.ts";
import { backupQuery, backupRunning, type StartOverStep, useStartBackup, useStartOver } from "../../api/backup.ts";
import { useBackupFolder } from "../../api/backup-folder.ts";
import { ApiError } from "../../api/client.ts";
import { agentsQuery, archivedAgentsQuery, threadsQuery } from "../../api/queries.ts";
import { formatAgo, formatList } from "../../lib/format.ts";
import { hobState } from "../../lib/hob-state.ts";
import { messages } from "./messages.ts";
import { AllClear, Deleting, Failed } from "./start-over-steps.tsx";

const copy = messages.startOver;

/** The words of a refusal: the hub's reason when it gave one. */
const reasonOf = (error: Error | null) =>
  error instanceof ApiError && typeof error.fields.reason === "string" ? error.fields.reason : (error?.message ?? "");

/** When the last backup finished, or null when none has. */
const lastBackupAt = (state: BackupState | undefined) => (state?._tag === "Done" ? state.finishedAt : null);

/**
 * Settings › Your data › Start over (#948): a rose card at the bottom of the section. Delete
 * everything… opens the dialog that confirms it.
 */
export function StartOver() {
  const [open, setOpen] = useState(false);
  const backup = useQuery(backupQuery);
  const last = lastBackupAt(backup.data?.state);
  return (
    <section
      aria-labelledby="start-over-heading"
      className="flex flex-col gap-2.5 rounded-card border border-rose/45 bg-rose/6 p-4"
    >
      <span className="flex items-center gap-2.5">
        <span aria-hidden className="grid size-6 place-items-center rounded-full bg-rose/18 text-rose">
          <BinIcon />
        </span>
        <strong id="start-over-heading" className="flex-1 text-text-strong">
          {copy.heading}
        </strong>
      </span>
      <span className="text-ui text-text-secondary">{copy.body}</span>
      <span className="flex flex-wrap items-center gap-3">
        <Button variant="deny" onClick={() => setOpen(true)}>
          {copy.open}
        </Button>
        <span className="text-detail text-label">
          {last === null ? copy.noBackup : copy.lastBackup({ when: formatAgo(last) })}
        </span>
      </span>
      {open && <StartOverDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function BinIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9M6.8 7v4.5M9.2 7v4.5" />
    </svg>
  );
}

/**
 * The confirmation, then the deleting steps, then All clear. While the hub deletes, the dialog
 * cannot be closed: there is nothing to go back to.
 */
function StartOverDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<StartOverStep | null>(null);
  const startOver = useStartOver(setStep);
  const busy = step !== null && step !== "done" && !startOver.isError;
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent
        aria-describedby="start-over-lead"
        aria-busy={busy}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
        variant="sheet"
        className="max-h-[calc(100vh-32px)] max-w-[520px]"
      >
        {startOver.isError ? (
          <Failed reason={reasonOf(startOver.error)} onClose={onClose} />
        ) : step === "done" ? (
          <AllClear />
        ) : step !== null ? (
          <Deleting step={step} />
        ) : (
          <Confirm onClose={onClose} onDelete={() => startOver.mutate()} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What goes, what stays, who is working, a way back, and the check box Delete everything waits for. */
function Confirm({ onClose, onDelete }: { onClose: () => void; onDelete: () => void }) {
  const [checked, setChecked] = useState(false);
  const backup = useQuery(backupQuery);
  const running = backupRunning(backup.data?.state);
  return (
    <>
      <DialogTitle variant="heading">{copy.title}</DialogTitle>
      <DialogDescription id="start-over-lead" variant="lead">
        {copy.lead}
      </DialogDescription>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <WhatGoes />
        <List label={copy.stays} items={copy.staysItems} glyph="✓" tone="text-mint" />
      </div>
      <Working />
      <WayBack />
      <label className="flex cursor-pointer items-start gap-2.5 rounded-control bg-rose/12 px-3 py-2.5 text-ui">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
          className="mt-0.5 size-4 flex-none accent-rose"
        />
        <span>
          <strong className="text-rose">{copy.confirmRisk}</strong> {copy.confirm}
        </span>
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {copy.keep}
        </Button>
        <Button variant="deny" disabled={!checked || running} onClick={onDelete}>
          {copy.delete}
        </Button>
      </div>
    </>
  );
}

function WhatGoes() {
  const hobs = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const count = (hobs.data?.length ?? 0) + (retired.data?.length ?? 0);
  const items = count > 0 ? [copy.goesItems.hobs({ count }), ...copy.goesItems.rest] : copy.goesItems.rest;
  return <List label={copy.goes} items={items} glyph="✕" tone="text-rose" />;
}

function List({
  label,
  items,
  glyph,
  tone,
}: {
  label: string;
  items: ReadonlyArray<string>;
  glyph: string;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-control bg-card p-3">
      <span className="lbl text-label">{label}</span>
      <ul aria-label={label} className="m-0 flex list-none flex-col gap-1.5 p-0 text-detail">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden className={`w-3 flex-none ${tone}`}>
              {glyph}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The hobs replying right now, which stop at once. Nothing when none is. */
function Working() {
  const hobs = useQuery(agentsQuery).data ?? [];
  const threads = useQueries({ queries: hobs.map((hob) => threadsQuery(hob.id)) });
  const activity = useActivity();
  const names = hobs
    .filter((hob, index) => {
      const state = hobState(hob, threads[index]?.data, activity);
      return state === "working" || state === "thinking";
    })
    .map((hob) => hob.name);
  if (names.length === 0) return null;
  return (
    <p className="m-0 flex items-center gap-2.5 rounded-control bg-lantern/10 px-3 py-2.5 text-detail">
      <span aria-hidden className="text-lantern">
        !
      </span>
      <span>{copy.working({ names: formatList(names), count: names.length })}</span>
    </p>
  );
}

/** Back up first, to the folder chosen under Backups, without leaving the dialog. */
function WayBack() {
  const backup = useQuery(backupQuery);
  const start = useStartBackup();
  const state = backup.data?.state;
  const destination = useBackupFolder(backup.data?.defaultDestination);
  const running = backupRunning(state) || start.isPending;
  const last = lastBackupAt(state);
  const saved = last !== null && start.isSuccess;
  const line = backupLine(state, running, destination, start.isError ? reasonOf(start.error) : null);
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-control bg-card px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="text-ui text-text-strong">{copy.wayBack}</strong>
        <span role="status" className="text-detail text-text-secondary">
          {line}
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={running || saved || destination === "" || backup.data === undefined}
        onClick={() => start.mutate(destination)}
      >
        {saved ? copy.backedUp : running ? copy.backupRunning : copy.backUp}
      </Button>
    </div>
  );
}

/** The line beside Back up first: why it waits, how the backup goes, or when the last one finished. */
const backupLine = (state: BackupState | undefined, running: boolean, destination: string, refused: string | null) => {
  if (refused !== null) return copy.backupFailed({ reason: refused });
  if (running) return copy.backupRunning;
  if (state?._tag === "Failed") return copy.backupFailed({ reason: state.reason });
  if (state?._tag === "Done") return copy.backupDone({ when: formatAgo(state.finishedAt), path: state.path });
  return destination === "" ? copy.backupNoFolder : copy.backupNone({ folder: destination });
};
