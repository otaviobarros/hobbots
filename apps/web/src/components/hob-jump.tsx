import type { Agent } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { agentsQuery } from "../api/queries.ts";
import { matchesHob } from "../lib/crew.ts";
import { HobSprite } from "./hob-sprite.tsx";

/** ⌘K (Ctrl+K elsewhere) from any page opens a finder that jumps to a hob's chat. */
export function HobJump() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k")
        return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A modal dialog keeps focus inside, closes on Escape and gives focus back when it closes.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes the dialog with Escape; the click is for the backdrop.
    <dialog
      ref={dialog}
      aria-label="Jump to a hob"
      onClose={() => setOpen(false)}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself; inside it lands on its content.
        if (event.target === event.currentTarget) setOpen(false);
      }}
      className="cut mx-auto mt-[14vh] w-[440px] max-w-[calc(100vw-32px)] border-2 border-control bg-panel p-0 text-text backdrop:bg-deep/70"
    >
      {open && <JumpList onDone={() => setOpen(false)} />}
    </dialog>
  );
}

function JumpList({ onDone }: { onDone: () => void }) {
  const agents = useQuery(agentsQuery);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = (agents.data ?? []).filter((hob) => matchesHob(hob, query));
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const activeId = matches[current]?.id;

  // Focus stays in the input, so the list scrolls itself to keep the active hob in sight.
  useEffect(() => {
    if (activeId) document.getElementById(`hob-jump-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const go = (hob: Agent | undefined) => {
    if (!hob) return;
    onDone();
    void navigate({ to: "/hobs/$hobId", params: { hobId: hob.id } });
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      <input
        // biome-ignore lint/a11y/noAutofocus: the finder opens for typing, as a command palette does.
        autoFocus
        type="text"
        role="combobox"
        aria-expanded
        aria-controls="hob-jump-list"
        aria-activedescendant={activeId ? `hob-jump-${activeId}` : undefined}
        aria-label="Find a hob by name or craft"
        placeholder="Jump to a hob…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (matches.length === 0) return;
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current + step + matches.length) % matches.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            go(matches[current]);
          }
        }}
        className="border-2 border-control bg-deep px-2.5 py-2 text-[15px] text-text placeholder:text-label"
      />
      <div
        id="hob-jump-list"
        role="listbox"
        aria-label="Hobs"
        className="flex max-h-[320px] flex-col overflow-y-auto p-0"
      >
        {matches.map((hob, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input moves through the options and opens one with Enter.
          <div
            key={hob.id}
            tabIndex={-1}
            id={`hob-jump-${hob.id}`}
            role="option"
            aria-selected={index === current}
            onClick={() => go(hob)}
            onMouseMove={() => setActive(index)}
            className={cn("flex cursor-pointer items-center gap-2.5 px-2 py-1.5", index === current && "bg-line")}
          >
            <HobSprite hob={hob} size={24} state={hob.status === "paused" ? "paused" : "idle"} />
            <span className="font-pixel text-sm font-semibold">{hob.name}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-label">{hob.craft}</span>
            {index === current && <span className="text-xs text-label">↵ open</span>}
          </div>
        ))}
        {agents.isSuccess && matches.length === 0 && (
          <p className="m-0 px-2 py-1.5 text-sm text-secondary-text">No hob matches “{query.trim()}”.</p>
        )}
      </div>
    </div>
  );
}
