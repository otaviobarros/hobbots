import { ReplyMarkdown } from "../../markdown/reply-markdown.tsx";
import { documentDiff, type MarkedDocument } from "./changes-model.ts";
import { remarkMarkChanges } from "./mark-changes.ts";
import { messages } from "./messages.ts";

const labels = { added: messages.added, removed: messages.removed } as const;

/**
 * A document's change, rendered: the earlier version with the blocks the change removed marked, and
 * the later one with those it added, side by side where there is room. Each version is rendered
 * whole, so its references resolve. An added or deleted file shows its one version unmarked.
 */
export function DocumentView({ before, after }: { before: string | null; after: string | null }) {
  const versions = documentDiff(before, after);
  return (
    <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
      {versions.before !== null && <Version title={messages.before} version={versions.before} />}
      {versions.after !== null && <Version title={messages.after} version={versions.after} />}
    </div>
  );
}

function Version({ title, version }: { title: string; version: MarkedDocument }) {
  return (
    <section aria-label={title} className="cut flex min-w-0 flex-col gap-2 bg-panel px-4 py-3">
      <h4 className="m-0 font-heading text-xs font-bold tracking-widest text-label uppercase">{title}</h4>
      <ReplyMarkdown
        content={version.text}
        streaming={false}
        caret={false}
        remarkPlugins={[remarkMarkChanges(version.marks, labels)]}
      />
    </section>
  );
}
