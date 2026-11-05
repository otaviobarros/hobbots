import type { MemoryPageRead } from "@hobbots/api";
import { MemoryForgetDay, type MemoryVersion } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Input } from "@hobbots/ui/components/input";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { changedPage, forgetDayLabel, localDay, suggestedForgetDay, versionRef } from "./memory-edit-model.ts";
import { type MemoryView, memorySearchOf, pageTitle } from "./memory-model.ts";
import { MemoryCard } from "./memory-parts.tsx";
import { messages } from "./messages.ts";
import { failureFlash, type MemoryFlash, type MemoryWrites } from "./use-memory-writes.ts";

const copy = messages;

/** Says a line after a change, on `at` when the change leaves the view it was made on. */
export type Say = (flash: MemoryFlash, at?: MemoryView) => void;

/**
 * Writes `version` back as a new version by you, and says so: Restore in History, and Undo after a
 * delete, which opens the page again.
 */
export const useRestore = (writes: MemoryWrites, say: Say) => {
  const navigate = useNavigate();
  return (read: Pick<MemoryPageRead["page"], "scope" | "path">, version: MemoryVersion, message: string) =>
    writes.restore.mutate(versionRef(read.scope, read.path, version), {
      onSuccess: () => {
        const at: MemoryView = { _tag: "Page", scope: read.scope, path: read.path, version: null };
        say({ tone: "done", message }, at);
        void navigate({ to: "/memory", search: memorySearchOf(at) });
      },
      onError: (error) => say(failureFlash(error)),
    });
};

/**
 * A page's actions (#959): Edit, Pin or Unpin, Forget on a date and Delete. Each is a new version by
 * you, written over the version on screen, so a hob's save made meanwhile is never lost: the change
 * is refused and the page shows that save.
 */
export function MemoryActions({ read, writes, say }: { read: MemoryPageRead; writes: MemoryWrites; say: Say }) {
  const { page } = read;
  const navigate = useNavigate();
  const restore = useRestore(writes, say);
  const [open, setOpen] = useState<"none" | "forget" | "delete">("none");
  const [day, setDay] = useState(() => page.forgetOn ?? suggestedForgetDay(new Date()));
  const dayId = useId();
  const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day) && day > localDay(new Date());
  const scopeView: MemoryView = { _tag: "Scope", scope: page.scope, kind: null };

  const pin = () =>
    writes.save.mutate(changedPage(page, { pinned: !page.pinned }), {
      onSuccess: () => say({ tone: "done", message: page.pinned ? copy.actions.unpinned : copy.actions.pinned }),
      onError: (error) => say(failureFlash(error)),
    });
  const forget = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dayOk) return;
    const forgetOn = MemoryForgetDay.make(day);
    writes.save.mutate(changedPage(page, { forgetOn }), {
      onSuccess: () => {
        setOpen("none");
        say({ tone: "done", message: copy.actions.forgetSet({ day: forgetDayLabel(forgetOn) }) });
      },
      onError: (error) => say(failureFlash(error)),
    });
  };
  const remove = () =>
    writes.remove.mutate(versionRef(page.scope, page.path, page.version), {
      onSuccess: ({ restoreFrom }) => {
        const undo = restoreFrom === null ? undefined : () => restore(page, restoreFrom, copy.actions.broughtBack);
        say(
          { tone: "done", message: copy.actions.deleted({ title: pageTitle(page.markdown, page.path) }), undo },
          scopeView,
        );
        void navigate({ to: "/memory", search: memorySearchOf(scopeView) });
      },
      onError: (error) => {
        setOpen("none");
        say(failureFlash(error));
      },
    });

  const action = "w-full justify-start";
  return (
    <MemoryCard label={copy.actions.label}>
      <h3 className="lbl m-0 text-label">{copy.actions.label}</h3>
      <Button variant="outline" size="sm" className={action} asChild>
        <Link to="/memory" search={memorySearchOf({ _tag: "Edit", scope: page.scope, path: page.path })}>
          {copy.actions.edit}
        </Link>
      </Button>
      <Button
        variant="outline"
        size="sm"
        className={action}
        aria-pressed={page.pinned}
        disabled={writes.busy}
        onClick={pin}
      >
        {page.pinned ? copy.actions.unpin : copy.actions.pin}
      </Button>
      <Button
        variant="quiet"
        size="sm"
        className={action}
        aria-expanded={open === "forget"}
        onClick={() => setOpen(open === "forget" ? "none" : "forget")}
      >
        {copy.actions.forgetOnDate}
      </Button>
      {open === "forget" && (
        <form onSubmit={forget} className="flex flex-col gap-2 ps-2">
          <label htmlFor={dayId} className="text-ui">
            {copy.actions.forgetOn}
          </label>
          <Input
            id={dayId}
            type="date"
            value={day}
            min={localDay(new Date())}
            onChange={(event) => setDay(event.target.value)}
          />
          <span className="text-meta text-label">{copy.actions.forgetHint}</span>
          <span className="flex gap-2">
            <Button type="submit" size="sm" disabled={!dayOk || writes.busy}>
              {writes.save.isPending ? copy.actions.working : copy.actions.setForget}
            </Button>
            <Button type="button" variant="quiet" size="sm" onClick={() => setOpen("none")}>
              {copy.actions.cancel}
            </Button>
          </span>
        </form>
      )}
      <Button
        variant="quietDeny"
        size="sm"
        className={action}
        aria-expanded={open === "delete"}
        onClick={() => setOpen(open === "delete" ? "none" : "delete")}
      >
        {copy.actions.delete}
      </Button>
      {open === "delete" && (
        <div className="flex flex-col gap-2 ps-2">
          <span className="text-ui text-text-secondary">{copy.actions.deleteConfirm}</span>
          <span className="flex gap-2">
            <Button variant="deny" size="sm" disabled={writes.busy} onClick={remove}>
              {writes.remove.isPending ? copy.actions.working : copy.actions.deleteYes}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setOpen("none")}>
              {copy.actions.cancel}
            </Button>
          </span>
        </div>
      )}
    </MemoryCard>
  );
}

/** The day the page is forgotten, under its title, with Keep it. */
export function ForgetNotice({ read, writes, say }: { read: MemoryPageRead; writes: MemoryWrites; say: Say }) {
  const { page } = read;
  if (page.forgetOn === null) return null;
  const keep = () =>
    writes.save.mutate(changedPage(page, { forgetOn: null }), {
      onSuccess: () => say({ tone: "done", message: copy.actions.kept }),
      onError: (error) => say(failureFlash(error)),
    });
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-card bg-notice px-3.5 py-2.5 text-ui">
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="font-semibold text-text-strong">{copy.forget.notice({ day: forgetDayLabel(page.forgetOn) })}</b>
        <span className="text-detail text-text-secondary">{copy.forget.hint}</span>
      </span>
      <Button variant="outline" size="sm" disabled={writes.busy} onClick={keep}>
        {copy.forget.keep}
      </Button>
    </div>
  );
}
