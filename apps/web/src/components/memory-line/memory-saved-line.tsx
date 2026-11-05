import type { Agent, MemorySave } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useUndoMemorySave } from "../../api/memory-saves.ts";
import { memorySearchOf } from "../memory/memory-model.ts";
import { MemoryIcon } from "../memory/memory-parts.tsx";
import { savedLine, undoFailure } from "./memory-line-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

const action =
  "cursor-pointer rounded-control border-0 bg-transparent px-2 py-0.5 font-[inherit] text-detail text-link no-underline hover:bg-hover disabled:cursor-default disabled:opacity-60";

/**
 * The quiet lines under a reply for what it saved to the hob's memory (ADR 028, #961): what was
 * saved, with Open, which reads the page in Memory, and Undo, which puts back the version the save
 * replaced or removes the page it made.
 */
export function MemorySavedLines({ saves, hob }: { saves: ReadonlyArray<MemorySave>; hob: Agent }) {
  if (saves.length === 0) return null;
  return (
    <ul aria-label={copy.label({ name: hob.name })} className="m-0 flex list-none flex-col gap-1.5 p-0 pt-1">
      {saves.map((save) => (
        <MemorySavedLine key={save.id} save={save} name={hob.name} />
      ))}
    </ul>
  );
}

/**
 * Says that a thread's saves could not be read, so no reply shows its line, and offers to read them
 * again: without it, a failed read would look like a chat in which nothing was saved.
 */
export function MemorySavesUnread({ name, retry }: { name: string; retry: () => void }) {
  return (
    <p role="alert" className="m-0 flex items-center gap-3 rounded-card bg-notice px-4 py-3 text-detail text-text">
      <MemoryIcon name="book" size={14} />
      <span className="min-w-0 flex-1">{copy.unread({ name })}</span>
      <Button variant="outline" size="xs" onClick={retry}>
        {copy.retry}
      </Button>
    </p>
  );
}

function MemorySavedLine({ save, name }: { save: MemorySave; name: string }) {
  const undo = useUndoMemorySave();
  const line = savedLine(save, name);
  return (
    <li className="flex animate-hb-in flex-col gap-1">
      <span
        role="status"
        className="flex flex-wrap items-center gap-2 rounded-card border border-line-2 py-1.5 ps-3 pe-1.5 text-detail text-text-secondary"
      >
        <MemoryIcon name="book" size={14} />
        <span className="min-w-0 flex-1">{line.text}</span>
        {line.actions && (
          <>
            <Link
              to="/memory"
              search={memorySearchOf({ _tag: "Page", scope: save.scope, path: save.path, version: null })}
              aria-label={copy.openLabel({ title: line.title })}
              className={action}
            >
              {copy.open}
            </Link>
            <button
              type="button"
              disabled={undo.isPending}
              aria-label={copy.undoLabel({ title: line.title })}
              onClick={() => undo.mutate(save)}
              className={action}
            >
              {copy.undo}
            </button>
          </>
        )}
      </span>
      {undo.isError && !undo.isPending && (
        <span role="alert" className="ps-3 text-detail text-rose">
          {undoFailure(undo.error, name)}
        </span>
      )}
    </li>
  );
}
