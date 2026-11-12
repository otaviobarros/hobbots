import type { Agent, CampSuggestion, Chapter, Thread } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { campSuggestionsQuery, useKeepInChat } from "../../api/camp-suggestions.ts";
import { formatList } from "../../lib/format.ts";
import { messages as chapterCopy } from "../chapters/messages.ts";
import type { CampFrom } from "./make-camp-sheet.tsx";
import { messages } from "./messages.ts";

const copy = messages.suggestion;

/** A chapter's title as the card names it: its own, or its number when nobody named it. */
export const chapterName = (chapter: Chapter): string =>
  chapter.title ?? chapterCopy.divider.untitled({ number: chapter.number });

/** Why a suggestion was raised, one phrase per reason, as its chips and the sheet say it. */
const reasonsOf = (suggestion: CampSuggestion): ReadonlyArray<string> =>
  suggestion.reasons.map((reason) => copy.reason[reason.code](reason));

/** What Make a camp moves for a suggestion: its chapter and why it was suggested. */
const suggestedFrom = (suggestion: CampSuggestion, chapter: Chapter): CampFrom => ({
  chapter,
  title: chapterName(chapter),
  detail: formatList(reasonsOf(suggestion)),
});

/**
 * The hub's camp suggestions in a chat (ADR 037, #1385): a card for each open one, with Make it a
 * camp, which opens Make a camp with its chapter coming along, and Keep it in my chat, after which
 * it never comes back.
 */
export function CampSuggestions({
  hob,
  thread,
  chapters,
  onMake,
}: {
  hob: Agent;
  thread: Thread;
  chapters: ReadonlyArray<Chapter>;
  onMake: (from: CampFrom) => void;
}) {
  const suggestions = useQuery({ ...campSuggestionsQuery(thread.id), enabled: thread.kind === "chat" });
  const keep = useKeepInChat(thread.id);
  const kept = keep.data === undefined ? undefined : chapters.find((each) => each.id === keep.data.chapterId);
  return (
    <>
      {(suggestions.data ?? []).map((suggestion) => {
        const chapter = chapters.find((each) => each.id === suggestion.chapterId);
        return chapter === undefined ? null : (
          <SuggestionCard
            key={suggestion.id}
            hob={hob}
            suggestion={suggestion}
            chapter={chapter}
            keeping={keep.isPending && keep.variables === suggestion.id}
            onMake={() => onMake(suggestedFrom(suggestion, chapter))}
            onKeep={() => keep.mutate(suggestion.id)}
          />
        );
      })}
      {kept !== undefined && (
        <p role="status" className="m-0 text-ui text-text-secondary">
          {copy.kept({ name: hob.name, title: chapterName(kept) })}
        </p>
      )}
      {keep.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.keepFailed}
        </p>
      )}
    </>
  );
}

function SuggestionCard({
  hob,
  suggestion,
  chapter,
  keeping,
  onMake,
  onKeep,
}: {
  hob: Agent;
  suggestion: CampSuggestion;
  chapter: Chapter;
  keeping: boolean;
  onMake: () => void;
  onKeep: () => void;
}) {
  const heading = copy.heading({ title: chapterName(chapter) });
  return (
    <section
      aria-label={heading}
      className="flex animate-hb-in flex-col gap-2.5 rounded-card bg-card p-4 border-(length:--edge) border-line"
    >
      <span className="flex items-center gap-1.5 text-meta font-semibold text-star">
        <span aria-hidden>{messages.header.glyph}</span>
        {copy.eyebrow({ name: hob.name })}
      </span>
      <h3 className="m-0 text-title font-semibold text-text-strong">{heading}</h3>
      <p className="m-0 text-ui text-text-secondary">{copy.lead}</p>
      <ul aria-label={copy.why} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {reasonsOf(suggestion).map((reason) => (
          <li key={reason}>
            <Badge variant="resting">{reason}</Badge>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onMake}>
          {copy.make}
        </Button>
        <Button variant="outline" size="sm" disabled={keeping} onClick={onKeep}>
          {keeping ? copy.keeping : copy.keep}
        </Button>
      </div>
      <span className="text-meta text-label">{copy.why}</span>
    </section>
  );
}
