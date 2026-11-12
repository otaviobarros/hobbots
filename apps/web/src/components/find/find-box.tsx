import { type Actor, type Agent, searchTerms, type Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SearchField } from "@hobbots/ui/components/search-field";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useAsk, useFind } from "../../api/find.ts";
import { agentsQuery } from "../../api/queries.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { AskAnswerCard, type AskView } from "./ask-answer.tsx";
import { type FindRow, findGroups, foundNothing } from "./find-model.ts";
import { FindGroups } from "./find-rows.tsx";
import { messages as copy } from "./messages.ts";

type Scope = "here" | "everywhere";

// The box opens focused and stays lit while open, so the glow does not wait for focus. Its text is
// the 15px body style, a step up from the other search fields, since it sits over a chat.
const glow =
  "border-focus-ring hover:border-focus-ring shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-focus-ring)_22%,transparent)] [&_input]:text-body [&_input]:text-text-strong";

/** The magnifier in the chat header: pressed while Find is open. */
export function FindButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
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
      <SearchIcon />
    </Button>
  );
}

/**
 * Find, under the chat header (ADR 037, #1386): what matches in this chat or camp, or everywhere,
 * grouped into decisions, artifacts, chapters and messages; a crossed-out decision shows crossed
 * out. Enter, or the first row, asks the hob, who answers from the records and cites each one; a
 * citation or a row opens the message it came from. The first Escape clears the text and the next
 * closes it, as ✕ does.
 */
export function FindBox({
  hob,
  thread,
  onClose,
  onPick,
}: {
  hob: Agent;
  thread: Thread;
  onClose: () => void;
  /** Told of each pick, even of the message already open, which the address alone would not say. */
  onPick?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("here");
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => input.current?.focus(), []);
  const inScope = scope === "here" ? thread.id : null;
  const find = useFind(query, inScope);
  const found = useDeferredValue(find.found);
  const ask = useAsk();
  const hobs = useQuery(agentsQuery);
  const question = query.trim();
  const searching = searchTerms(question).length > 0;
  // An answer shows only for the question and the place it was asked about, so typing on hides it.
  const asked = ask.variables?.question === question && ask.variables.scope === inScope;
  const view: AskView | null = !asked
    ? null
    : ask.isPending
      ? { step: "asking" }
      : ask.isError
        ? { step: "failed" }
        : ask.data === undefined
          ? null
          : { step: "answered", answer: ask.data };
  const askNow = () => {
    if (searching && !ask.isPending) ask.mutate({ question, scope: inScope });
  };
  const nameOf = (actor: Actor | null) =>
    actor === null || actor.kind === "user"
      ? copy.you
      : actor.kind === "hub"
        ? copy.hub
        : (hobs.data?.find((each) => each.id === actor.id)?.name ?? hob.name);
  const close = () => {
    onClose();
    document.querySelector<HTMLElement>("[data-chat-search-toggle]")?.focus();
  };
  const pick = (row: FindRow) => {
    onClose();
    // Told once the address names the message, so the pick never acts on the one open before it.
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId: row.target.hobId, threadId: row.target.threadId },
      search: row.target.messageId === null ? {} : { message: row.target.messageId },
    }).then(() => onPick?.());
  };
  const groups = findGroups(found, scope === "everywhere");
  return (
    <div className="relative z-10 animate-hb-in px-6 pt-2.5">
      <search>
        <SearchField
          ref={input}
          aria-label={copy.label}
          placeholder={copy.placeholder}
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            askNow();
          }}
          clearLabel={copy.clear}
          onEscape={close}
          slashKey={false}
          clearButton={false}
          trailing={
            <>
              <SegmentedControl size="sm" aria-label={copy.scope} value={scope} onValueChange={setScope}>
                <SegmentedControlItem value="here">{copy.here({ kind: thread.kind })}</SegmentedControlItem>
                <SegmentedControlItem value="everywhere">{copy.everywhere}</SegmentedControlItem>
              </SegmentedControl>
              {/* Borderless and inset from the field's edge, like the field's own clear button. */}
              <Button
                variant="quiet"
                size="icon"
                aria-label={copy.close}
                title={copy.close}
                onClick={close}
                className="me-1 size-hit-min"
              >
                <CloseIcon />
              </Button>
            </>
          }
          className={glow}
        />
      </search>
      {searching && (
        <section
          aria-label={copy.results}
          className="absolute inset-x-6 top-[calc(100%+6px)] flex max-h-[440px] flex-col gap-0.5 overflow-y-auto rounded-card border border-line-2 bg-card p-1.5 shadow-menu"
        >
          {view !== null && (
            <AskAnswerCard
              hob={hob}
              view={view}
              everywhere={scope === "everywhere"}
              nameOf={nameOf}
              onCite={pick}
              onRetry={askNow}
            />
          )}
          <button
            type="button"
            onClick={askNow}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-control border-0 bg-star/9 px-2.5 py-2 text-start text-ui text-text-strong hover:bg-star/15"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[max(0px,calc(var(--corner-tile)-3px))] bg-tile">
              <HobSprite hob={hob} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate">{copy.ask({ name: hob.name, question })}</span>
            <kbd className="font-sans text-meta text-label">{copy.askKey}</kbd>
          </button>
          <FindGroups groups={groups} nameOf={nameOf} onPick={pick} />
          {find.error && <p className="m-0 px-2.5 py-2 text-ui text-text-secondary">{copy.failed}</p>}
          {!find.error && !find.pending && foundNothing(found) && (
            <p className="m-0 px-2.5 py-2 text-ui text-text-secondary">{copy.nothing({ name: hob.name })}</p>
          )}
        </section>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width={16}
      height={16}
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
