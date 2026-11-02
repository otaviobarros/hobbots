import { cn } from "@hobbots/ui/lib/utils";
import { ReplyMarkdown } from "../../markdown/reply-markdown.tsx";
import { type DocumentBlock, documentDiff } from "./changes-model.ts";
import { messages } from "./messages.ts";

/**
 * A document's change, rendered: the earlier version with the blocks the change removed marked, and
 * the later one with those it added, side by side where there is room. An added or deleted file
 * shows its one version unmarked.
 */
export function DocumentView({ before, after }: { before: string | null; after: string | null }) {
  const blocks = documentDiff(before, after);
  const both = before !== null && after !== null;
  return (
    <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
      {before !== null && <Version title={messages.before} blocks={blocks.before} marked={both} />}
      {after !== null && <Version title={messages.after} blocks={blocks.after} marked={both} />}
    </div>
  );
}

const markTone: Record<DocumentBlock["mark"], string> = {
  added: "bg-mint/12",
  removed: "bg-rose/14",
  same: "",
};

function Version({
  title,
  blocks,
  marked,
}: {
  title: string;
  blocks: ReadonlyArray<DocumentBlock>;
  /** Both versions are shown, so the blocks the change touched are marked; one alone has nothing to mark against. */
  marked: boolean;
}) {
  return (
    <section aria-label={title} className="cut flex min-w-0 flex-col gap-2 bg-panel px-4 py-3">
      <h4 className="m-0 font-pixel text-xs font-bold tracking-widest text-label uppercase">{title}</h4>
      {blocks.map((block) => {
        const mark = marked ? block.mark : "same";
        const Mark = mark === "added" ? "ins" : mark === "removed" ? "del" : "div";
        return (
          <Mark key={block.key} className={cn("block px-2 py-1 no-underline", markTone[mark])}>
            {mark !== "same" && <span className="sr-only">{mark === "added" ? messages.added : messages.removed}</span>}
            <ReplyMarkdown content={block.text} streaming={false} caret={false} />
          </Mark>
        );
      })}
    </section>
  );
}
