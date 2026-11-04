import type { Agent, Message, SnippetPart, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { formatWhen } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { findInChat, MIN_QUERY } from "./chat-search-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** The magnifier in the chat header: pressed while the search box is open. */
export function ChatSearchButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="icon"
      size="icon"
      aria-label={copy.open}
      title={copy.open}
      aria-expanded={open}
      onClick={onToggle}
      data-chat-search-toggle=""
    >
      <SearchIcon size={16} />
    </Button>
  );
}

/**
 * The search box under the chat header: a count of the messages that match, and below it a list of
 * them, each with who said it, when, and the match marked in lantern. Picking one scrolls the chat to
 * it; nothing found offers a search across all of the hob's chats. Escape or ✕ closes it.
 */
export function ChatSearch({
  hob,
  threadId,
  transcript,
  onClose,
}: {
  hob: Agent;
  threadId: ThreadId;
  transcript: ReadonlyArray<Message>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => input.current?.focus(), []);
  const hits = findInChat(transcript, query);
  const searching = query.trim().length >= MIN_QUERY;
  const close = () => {
    onClose();
    document.querySelector<HTMLElement>("[data-chat-search-toggle]")?.focus();
  };
  const pick = (message: Message) => {
    onClose();
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId: hob.id, threadId },
      search: { message: message.id },
    });
  };
  return (
    <div className="relative z-10 animate-hb-in px-6 pt-2.5">
      <search className="flex items-center gap-2.5 rounded-control border-(length:--edge) border-solid border-focus-ring bg-deep py-1 ps-3 pe-1.5 text-text-secondary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-focus-ring)_22%,transparent)]">
        <SearchIcon size={14} />
        <input
          ref={input}
          type="search"
          aria-label={copy.label}
          placeholder={copy.label}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && close()}
          className="min-w-0 flex-1 border-0 bg-transparent text-[15px] [&::-webkit-search-cancel-button]:appearance-none leading-[22px] text-text-strong outline-none placeholder:text-label"
        />
        {searching && (
          <span role="status" className="text-xs whitespace-nowrap text-label">
            {copy.count({ count: hits.length })}
          </span>
        )}
        <Button
          variant="icon"
          size="icon"
          aria-label={copy.close}
          title={copy.close}
          onClick={close}
          className="size-7"
        >
          <CloseIcon />
        </Button>
      </search>
      {searching && (
        <div className="absolute inset-x-6 top-[calc(100%+6px)] flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-card border border-line-2 bg-card p-1.5 shadow-menu">
          {hits.length > 0 ? (
            <ul aria-label={copy.matches} className="m-0 flex list-none flex-col gap-0.5 p-0">
              {hits.map((hit) => (
                <li key={hit.message.id}>
                  <button
                    type="button"
                    onClick={() => pick(hit.message)}
                    className="flex w-full cursor-pointer flex-col gap-0.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-start text-text hover:bg-hover focus-visible:bg-hover"
                  >
                    <Who hob={hob} message={hit.message} />
                    <span className="text-sm leading-5">
                      <Marked parts={hit.parts} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 px-2.5 py-2 text-sm leading-5 text-text-secondary">
              {copy.nothing({ query: query.trim() })}{" "}
              <Link to="/hobs/$hobId" params={{ hobId: hob.id }} search={{ q: query.trim() }} className="text-lantern">
                {copy.everywhere({ name: hob.name })}
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Who said a matching message, and when. */
function Who({ hob, message }: { hob: Agent; message: Message }) {
  const mine = message.role === "user";
  return (
    <span className="flex items-center gap-2 text-xs text-label">
      {mine ? (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-lantern/35 text-meta font-bold text-text-strong">
          {copy.you[0]}
        </span>
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-tile">
          <HobSprite hob={hob} size={16} />
        </span>
      )}
      {copy.hit({ who: mine ? copy.you : hob.name, when: formatWhen(message.createdAt) })}
    </span>
  );
}

/** A line of a message with the words that matched marked in lantern. */
function Marked({ parts }: { parts: ReadonlyArray<SnippetPart> }) {
  return parts.map((part, index) =>
    part.match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
      <mark key={index} className="rounded-[3px] bg-lantern/35 px-0.5 text-text-strong">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

function SearchIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" strokeLinecap="round" />
    </svg>
  );
}
