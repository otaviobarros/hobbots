import { type Artifact, MessageId, type Thread, type ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@hobbots/ui/components/dialog";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useReducer } from "react";
import { artifactsQuery } from "../../api/records.ts";
import { formatAgo, formatCount } from "../../lib/format.ts";
import { ARTIFACT_LIST, type ArtifactReadingEvent, readArtifacts } from "./artifact-flow.ts";
import { ArtifactPanel } from "./artifact-panel.tsx";
import { RowMark, RowPreview } from "./artifact-preview.tsx";
import { filterArtifacts, filterInEffect, isArtifactFilter, linkOf, shownFilters } from "./artifact-rows.ts";
import { messages } from "./messages.ts";
import { ReadState } from "./sheet-parts.tsx";

const copy = messages.artifacts;

/** The message an artifact was made at, to jump to, or null when no message holds it. */
const madeAt = (artifact: Artifact): MessageId | null =>
  artifact.origin.kind === "message" ? MessageId.make(artifact.origin.id) : null;

/**
 * The Artifacts tab (ADR 037): one row per artifact at its latest version, each with a short preview,
 * filtered by the kinds the camp has, with To review on each one waiting for you. Open draws it by its
 * kind with its versions, in the sheet or the full viewer, and settles its review (#1422, #1434).
 */
export function ArtifactsTab({
  thread,
  hobName,
  onJump,
}: {
  thread: Thread;
  hobName: string;
  onJump: (messageId: MessageId) => void;
}) {
  const artifacts = useQuery(artifactsQuery(thread.id));
  const [reading, dispatch] = useReducer(readArtifacts, ARTIFACT_LIST);
  const all = artifacts.data ?? [];
  const opened = reading.step === "list" ? undefined : all.find((artifact) => artifact.id === reading.artifactId);
  if (reading.step !== "list" && opened !== undefined) {
    const panel = (
      <ArtifactPanel
        threadId={thread.id}
        artifact={opened}
        hobName={hobName}
        picked={reading.version}
        onPick={(version) => dispatch({ _tag: "Pick", version })}
      />
    );
    return (
      <>
        <ArtifactDetail artifact={opened} dispatch={dispatch} onJump={onJump}>
          {reading.step === "open" ? panel : null}
        </ArtifactDetail>
        <Dialog open={reading.step === "full"} onOpenChange={(open) => !open && dispatch({ _tag: "Collapse" })}>
          <DialogContent aria-describedby={undefined} variant="sheet" className="max-h-[88vh] max-w-page-max">
            <DialogTitle variant="heading">{opened.title}</DialogTitle>
            {reading.step === "full" ? panel : null}
            <Button variant="outline" size="sm" className="self-end" onClick={() => dispatch({ _tag: "Collapse" })}>
              {copy.closeFull}
            </Button>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  const filter = filterInEffect(all, reading.filter);
  const shown = filterArtifacts(all, filter);
  return (
    <div className="flex flex-col gap-3">
      {all.length > 0 && (
        <FilterChips
          aria-label={copy.filterLabel}
          value={filter}
          onValueChange={(value) => isArtifactFilter(value) && dispatch({ _tag: "Filter", filter: value })}
        >
          {shownFilters(all).map((each) => (
            <FilterChip key={each} value={each} count={formatCount(filterArtifacts(all, each).length)}>
              {copy.filters[each]}
            </FilterChip>
          ))}
        </FilterChips>
      )}
      <ReadState read={artifacts} empty={shown.length > 0 ? undefined : copy.empty} />
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {shown.map((artifact) => (
          <ArtifactRow
            key={artifact.id}
            threadId={thread.id}
            artifact={artifact}
            onOpen={() => dispatch({ _tag: "Open", artifactId: artifact.id })}
          />
        ))}
      </ul>
      <p className="m-0 text-meta text-label">{copy.footnote}</p>
    </div>
  );
}

function ArtifactRow({ threadId, artifact, onOpen }: { threadId: ThreadId; artifact: Artifact; onOpen: () => void }) {
  return (
    <li className="flex items-start gap-2.5 rounded-control px-2 py-2 [content-visibility:auto] hover:bg-hover">
      <RowMark threadId={threadId} artifact={artifact} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui font-semibold text-text-strong">{artifact.title}</span>
        <span className="truncate text-meta text-label">
          {copy.meta({
            kind: copy.kind[artifact.kind],
            version: artifact.latestVersion,
            when: formatAgo(artifact.updatedAt),
          })}
        </span>
        <RowPreview threadId={threadId} artifact={artifact} />
      </span>
      {artifact.review === "waiting" && <Badge variant="waiting">{copy.review.toReview}</Badge>}
      <Button variant="text" size="xs" aria-label={copy.openOf({ title: artifact.title })} onClick={onOpen}>
        {copy.open}
      </Button>
    </li>
  );
}

/** An artifact open in the sheet: back to the list, its name, the full view, and where it is or was made. */
function ArtifactDetail({
  artifact,
  dispatch,
  onJump,
  children,
}: {
  artifact: Artifact;
  dispatch: (event: ArtifactReadingEvent) => void;
  onJump: (messageId: MessageId) => void;
  children: ReactNode;
}) {
  const link = linkOf(artifact);
  const message = madeAt(artifact);
  return (
    <section aria-label={artifact.title} className="flex flex-col gap-3">
      <Button variant="text" size="xs" className="self-start" onClick={() => dispatch({ _tag: "Back" })}>
        {copy.back}
      </Button>
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="m-0 min-w-0 flex-1 text-title font-semibold break-words text-text-strong">{artifact.title}</h3>
        <Button
          variant="outline"
          size="xs"
          aria-label={copy.fullViewOf({ title: artifact.title })}
          onClick={() => dispatch({ _tag: "Expand" })}
        >
          {copy.fullView}
        </Button>
      </div>
      <p className="m-0 font-mono text-detail break-all text-text-secondary">
        <span className="sr-only">{copy.where} </span>
        {artifact.locator}
      </p>
      {children}
      <div className="flex flex-wrap gap-2">
        {link !== null && (
          <Button asChild variant="outline" size="sm">
            <a href={link} target="_blank" rel="noreferrer">
              {copy.openLink}
            </a>
          </Button>
        )}
        {message !== null && (
          <Button variant="outline" size="sm" onClick={() => onJump(message)}>
            {copy.jump}
          </Button>
        )}
      </div>
    </section>
  );
}
