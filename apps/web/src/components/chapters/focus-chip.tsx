import type { FocusRead } from "@hobbots/api";
import type { Agent, PackPart, Thread } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@hobbots/ui/components/popover";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { chaptersQuery, focusQuery } from "../../api/chapters.ts";
import { chapterFocus } from "./chapter-sections.ts";
import { type FocusGroup, type FocusRow, focusRows, trimNotes } from "./focus-rows.ts";
import { messages } from "./messages.ts";

const copy = messages.focus;

const TONE: Readonly<Record<FocusGroup, "waiting" | "done">> = {
  always: "waiting",
  here: "done",
  carried: "done",
  archived: "waiting",
};

/**
 * The Focus chip in the chat's header (ADR 037): the live chapter it is focused on and how many rest,
 * and, open, what the hob reads each turn, row by row with each part's size, as the turn's
 * `PackReport` says. It reads the report each time it opens.
 */
export function FocusChip({ hob, thread }: { hob: Agent; thread: Thread }) {
  const [open, setOpen] = useState(false);
  const chapters = useQuery(chaptersQuery(thread.id));
  const label = copy.label(chapterFocus(chapters.data));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* In a narrow header, as beside a quest's Workbench, the chip keeps only its dot. */}
        <Button variant="chip" className="shrink-0" aria-label={label} title={label}>
          <span aria-hidden className="size-2 rounded-full bg-mint" />
          <span className="@max-[560px]/header:hidden">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={copy.heading({ name: hob.name })} className="w-[400px] max-w-[calc(100vw-32px)]">
        <div className="flex flex-col gap-2">
          <span className="font-heading text-ui text-text-strong">{copy.heading({ name: hob.name })}</span>
          {open && <FocusReport hob={hob} thread={thread} />}
          <p className="m-0 text-meta text-text-secondary">{copy.footer({ name: hob.name })}</p>
          <PopoverClose asChild>
            <Button variant="quiet" size="xs" className="self-end">
              {copy.close}
            </Button>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The report's rows, read as the chip opens, with its loading and error states. */
function FocusReport({ hob, thread }: { hob: Agent; thread: Thread }) {
  const focus = useQuery(focusQuery(thread.id));
  if (focus.isPending) {
    return (
      <span role="status" className="text-ui text-text-secondary">
        {copy.loading({ name: hob.name })}
      </span>
    );
  }
  if (focus.isError) {
    return (
      <span role="alert" className="flex flex-wrap items-center gap-2 text-ui text-rose">
        {copy.failed({ name: hob.name })}
        <Button variant="outline" size="xs" onClick={() => void focus.refetch()}>
          {copy.retry}
        </Button>
      </span>
    );
  }
  return <FocusRows hob={hob} thread={thread} read={focus.data} />;
}

function FocusRows({ hob, thread, read }: { hob: Agent; thread: Thread; read: FocusRead }) {
  const { report } = read;
  const used = { used: report.tokens, budget: report.budget };
  // A chat started fresh from an earlier one shows that chat as Archived: nothing reads it.
  const rows = focusRows(report, thread.kind === "chat" && thread.origin !== null);
  return (
    <>
      <span className="text-meta text-label">
        {read.of === "last-turn" ? copy.lastTurn(used) : copy.nextSession(used)}
      </span>
      <ul aria-label={copy.heading({ name: hob.name })} className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((row) => (
          <FocusRowItem key={row.group} hob={hob} camp={thread.kind === "camp"} row={row} />
        ))}
      </ul>
    </>
  );
}

function FocusRowItem({ hob, camp, row }: { hob: Agent; camp: boolean; row: FocusRow }) {
  const label = copy.group[row.group]({ camp });
  return (
    <li aria-label={label} className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-2.5 text-ui">
      <span className="flex flex-col items-start gap-0.5">
        <Badge variant={TONE[row.group]}>{label}</Badge>
        <span className="text-meta text-label tabular-nums">{copy.size({ count: row.tokens })}</span>
      </span>
      {row.group === "archived" ? (
        <span className="flex flex-col">
          <span className="text-text-strong">{copy.archived}</span>
          <span className="text-meta text-label">{copy.archivedNote}</span>
        </span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {row.parts.map((part) => (
            <PartLine key={part.part} hob={hob} part={part} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One part of the pack: what it is, its size, and what it left out to fit. */
function PartLine({ hob, part }: { hob: Agent; part: PackPart }) {
  const notes = trimNotes(part.trimmed);
  return (
    <li className="flex flex-col">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-text-strong">{copy.part[part.part]({ name: hob.name })}</span>
        <span className="shrink-0 text-meta text-label tabular-nums">{copy.size({ count: part.tokens })}</span>
      </span>
      {notes.kept !== null && <span className="text-meta text-lantern">{copy.trimmed(notes.kept)}</span>}
      {notes.cut > 0 && <span className="text-meta text-lantern">{copy.cut({ count: notes.cut })}</span>}
    </li>
  );
}
