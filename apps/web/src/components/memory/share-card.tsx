import { type MemoryShare, memoryKindOf } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { memoryNotAnswering } from "../../api/memory-pages.ts";
import { shareChangedMeanwhile, shareClosed, useDecideShare } from "../../api/memory-shares.ts";
import { DraftForm } from "../draft-form/draft-form.tsx";
import { type HobDirectory, memorySearchOf, scopeName } from "./memory-model.ts";
import { KindTag } from "./memory-parts.tsx";
import { messages } from "./messages.ts";
import { shareLines, shareOutcome, shareTitle } from "./review-model.ts";

const copy = messages.review;

/** Where a share would land, as the card's header names it. */
const destinationOf = (share: MemoryShare, hobs: HobDirectory) =>
  share.scope._tag === "Project"
    ? copy.destinationProject({ name: scopeName(share.scope, hobs) })
    : copy.destinationEveryone;

/** What would be shared: the page's kind, its title and where it goes, then each line it adds. */
export function ShareDiff({ share, hobs }: { share: MemoryShare; hobs: HobDirectory }) {
  return (
    <section
      aria-label={copy.editLabel}
      className="overflow-hidden rounded-card border border-line-2 bg-card"
      data-testid="share-diff"
    >
      <div className="flex items-center gap-2 border-b border-line bg-deep px-3 py-2.5 text-detail">
        <KindTag kind={memoryKindOf(share.path)} />
        <span className="min-w-0 flex-1 truncate text-text-strong">{shareTitle(share)}</span>
        <span className="text-label">{destinationOf(share, hobs)}</span>
      </div>
      <ul className="m-0 list-none p-0 py-1">
        {shareLines(share).map((line, at) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a page's lines have no identity but their place (STD-REACT-020).
            key={at}
            className="flex gap-2.5 bg-[color-mix(in_srgb,var(--color-mint)_12%,transparent)] px-3 py-1.5 text-ui text-text-strong"
          >
            <span aria-hidden className="w-2.5 flex-none text-mint">
              +
            </span>
            <span className="sr-only">{`${messages.page.added}: `}</span>
            <span className="min-w-0 break-words">{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a failed decision says. */
const errorText = (error: unknown) => {
  if (shareClosed(error)) return copy.closed;
  if (shareChangedMeanwhile(error)) return copy.changedMeanwhile;
  if (memoryNotAnswering(error)) return copy.notAnswering;
  return copy.failed;
};

/**
 * Your decision on a share: Share it, Edit then share, or Keep it private while it waits; what
 * happened, and Undo for a share that went through, once decided. `edit` says where editing
 * happens: here, or in Memory › To review, which the Inbox links to.
 */
export function ShareDecision({
  share,
  hobs,
  edit,
}: {
  share: MemoryShare;
  hobs: HobDirectory;
  edit: "here" | "in-memory";
}) {
  const decide = useDecideShare(share);
  const [editing, setEditing] = useState(false);
  const waiting = share.state === "waiting";
  const busy = decide.isPending;
  return (
    <div className="flex flex-col gap-3">
      {waiting && editing && (
        <DraftForm
          initial={share.markdown}
          label={copy.editLabel}
          hint={copy.editHint}
          submit={copy.shareEdited}
          back={copy.cancelEdit}
          rows={8}
          busy={busy}
          onSubmit={(markdown) => decide.mutate({ _tag: "share", markdown })}
          onBack={() => setEditing(false)}
        />
      )}
      {waiting && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => decide.mutate({ _tag: "share" })} disabled={busy}>
            {copy.shareIt}
          </Button>
          {edit === "here" ? (
            <Button variant="outline" onClick={() => setEditing(true)} disabled={busy}>
              {copy.editThenShare}
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link to="/memory" search={memorySearchOf({ _tag: "Review", item: share.id })}>
                {copy.editInMemory}
              </Link>
            </Button>
          )}
          <Button variant="quiet" onClick={() => decide.mutate({ _tag: "keep" })} disabled={busy}>
            {copy.keepPrivate}
          </Button>
        </div>
      )}
      {!waiting && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="m-0 text-ui text-text-strong">
            {shareOutcome(share, hobs)}
          </p>
          {share.state === "shared" && (
            <Button variant="outline" size="sm" onClick={() => decide.mutate({ _tag: "undo" })} disabled={busy}>
              {copy.undo}
            </Button>
          )}
        </div>
      )}
      {decide.isError && (
        <p role="alert" className="m-0 text-meta text-rose">
          {errorText(decide.error)}
        </p>
      )}
    </div>
  );
}
