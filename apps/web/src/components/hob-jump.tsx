import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { agentsQuery } from "../api/queries.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { messages } from "./messages.ts";
import { ArchivedTag, ResultDetail, resultLink, type SearchResult, useSearchResults } from "./search-results.tsx";

const copy = messages.jump;

/** ⌘K (Ctrl+K elsewhere) from any page opens a finder that jumps to a hob, or to a thread by its title or messages. */
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
      aria-label={copy.label}
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
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // An empty finder lists every hob; typing also finds threads by their title or messages.
  const agents = useQuery(agentsQuery);
  const found = useSearchResults(query);
  const options: ReadonlyArray<SearchResult> =
    query.trim() === ""
      ? (agents.data ?? []).map((hob) => ({ kind: "hob", key: `hob-${hob.id}`, hob }))
      : found.results;
  const current = Math.min(active, Math.max(0, options.length - 1));
  const activeKey = options[current]?.key;

  // Focus stays in the input, so the list scrolls itself to keep the active option in sight.
  useEffect(() => {
    if (activeKey) document.getElementById(`hob-jump-${activeKey}`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const go = (option: SearchResult | undefined) => {
    if (!option) return;
    onDone();
    void navigate(resultLink(option));
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
        aria-activedescendant={activeKey ? `hob-jump-${activeKey}` : undefined}
        aria-label={copy.input}
        placeholder={copy.placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (options.length === 0) return;
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current + step + options.length) % options.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            go(options[current]);
          }
        }}
        className="border-2 border-control bg-deep px-2.5 py-2 text-[15px] text-text placeholder:text-label"
      />
      <div
        id="hob-jump-list"
        role="listbox"
        aria-label={copy.list}
        className="flex max-h-[320px] flex-col overflow-y-auto p-0"
      >
        {options.map((option, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input moves through the options and opens one with Enter.
          <div
            key={option.key}
            tabIndex={-1}
            id={`hob-jump-${option.key}`}
            role="option"
            aria-selected={index === current}
            onClick={() => go(option)}
            onMouseMove={() => setActive(index)}
            className={cn("flex cursor-pointer items-center gap-2.5 px-2 py-1.5", index === current && "bg-line")}
          >
            <HobSprite hob={option.hob} size={24} state={option.hob.status === "paused" ? "paused" : "idle"} badge />
            {option.kind === "hob" ? (
              <>
                <span className="font-pixel text-sm font-semibold">{option.hob.name}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-label">{option.hob.roleTitle}</span>
              </>
            ) : (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-bold">
                  <span className="truncate">{option.hit.thread.title}</span>
                  <ArchivedTag result={option} />
                </span>
                <span className="truncate text-[13px] text-secondary-text">
                  <ResultDetail result={option} />
                </span>
              </span>
            )}
            {index === current && <span className="text-xs text-label">{copy.open}</span>}
          </div>
        ))}
        {query.trim() !== "" && !found.pending && options.length === 0 && (
          <p className="m-0 px-2 py-1.5 text-sm text-secondary-text">
            {messages.search.nothing({ query: query.trim() })}
          </p>
        )}
      </div>
    </div>
  );
}
