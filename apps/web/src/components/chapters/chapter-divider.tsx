import type { Chapter } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@hobbots/ui/components/menu";
import { formatDay } from "../../lib/time.ts";
import { messages as campCopy } from "../camps/messages.ts";
import { messages } from "./messages.ts";

const copy = messages.divider;

/** Merge with previous, offered on every chapter but the first. */
export interface MergeAction {
  readonly pending: boolean;
  readonly onMerge: () => void;
}

/** Where a fold opens or closes a resting chapter. */
export interface FoldAction {
  readonly folded: boolean;
  readonly onToggle: () => void;
}

/** A chapter's title as the transcript shows it: its own, or its number when nobody named it. */
const chapterTitleOf = (chapter: Chapter) => chapter.title ?? copy.untitled({ number: chapter.number });

/**
 * Where a chapter starts in the transcript (ADR 037). A live or opened chapter shows as a line with
 * its title and the day it started; a resting chapter folds to a box with its one-line summary,
 * which opens on Show. Its ⋯ menu offers Merge with previous and, in a chat, Make a camp from this
 * chapter.
 */
export function ChapterDivider({
  chapter,
  messageCount,
  fold,
  merge,
  makeCamp,
}: {
  chapter: Chapter;
  messageCount: number;
  /** Left out for the live chapter, which never folds. */
  fold: FoldAction | undefined;
  merge: MergeAction | undefined;
  /** Opens Make a camp with this chapter moving into it; left out in a camp. */
  makeCamp?: (() => void) | undefined;
}) {
  const title = chapterTitleOf(chapter);
  const menu = (merge || makeCamp) && <ChapterMenu title={title} merge={merge} makeCamp={makeCamp} />;
  if (fold?.folded) {
    return (
      <section
        aria-label={title}
        data-chapter={chapter.id}
        className="flex items-center gap-2.5 rounded-control border-(length:--edge) border-dashed border-line-2 py-2 ps-3 pe-2 text-ui"
      >
        <Badge variant="resting">{copy.resting}</Badge>
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="truncate font-semibold text-text-strong">{title}</b>
          <span className="truncate text-meta text-label">
            {chapter.summary ?? copy.count({ count: messageCount })}
          </span>
        </span>
        <Button
          variant="text"
          size="xs"
          aria-expanded={false}
          aria-label={copy.showChapter({ title })}
          onClick={fold.onToggle}
        >
          {copy.show}
        </Button>
        {menu}
      </section>
    );
  }
  return (
    <section
      aria-label={title}
      data-chapter={chapter.id}
      className="sticky -top-[18px] z-[2] flex items-center gap-3 bg-ground py-1.5 text-meta text-label"
    >
      <b className="font-bold text-text-strong">{title}</b>
      <span>{copy.started({ day: formatDay(chapter.startedAt) })}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
      {fold && (
        <Button variant="text" size="xs" aria-expanded aria-label={copy.foldChapter({ title })} onClick={fold.onToggle}>
          {copy.fold}
        </Button>
      )}
      {menu}
    </section>
  );
}

function ChapterMenu({
  title,
  merge,
  makeCamp,
}: {
  title: string;
  merge: MergeAction | undefined;
  makeCamp: (() => void) | undefined;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="quiet" size="icon" aria-label={copy.more({ title })} title={copy.more({ title })}>
          ⋯
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {makeCamp && <DropdownMenuItem onSelect={makeCamp}>{campCopy.suggestion.fromChapter}</DropdownMenuItem>}
        {merge && (
          <DropdownMenuItem disabled={merge.pending} onSelect={merge.onMerge}>
            {merge.pending ? copy.merging : copy.merge}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
