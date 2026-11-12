import { type Artifact, MessageId, type RegisteredArtifactId, type Thread } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { artifactsQuery } from "../../api/records.ts";
import { formatAgo, formatCount } from "../../lib/format.ts";
import { ARTIFACT_FILTERS, type ArtifactFilter, filterArtifacts, isArtifactFilter, linkOf } from "./artifact-rows.ts";
import { messages } from "./messages.ts";
import { ReadState } from "./sheet-parts.tsx";

const copy = messages.artifacts;

const KIND_ICON: Readonly<Record<Artifact["kind"], string>> = {
  code: "</>",
  page: "▤",
  doc: "¶",
  email: "✉",
  image: "▣",
  pr: "⑂",
  file: "▢",
};

/** The message an artifact was made at, to jump to, or null when no message holds it. */
const madeAt = (artifact: Artifact): MessageId | null =>
  artifact.origin.kind === "message" ? MessageId.make(artifact.origin.id) : null;

/**
 * The Artifacts tab (ADR 037): one row per artifact at its latest version, filtered by kind. Open
 * shows where it is, who made it and the message it was made at.
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
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [openId, setOpenId] = useState<RegisteredArtifactId | null>(null);
  const all = artifacts.data ?? [];
  const opened = all.find((artifact) => artifact.id === openId);
  if (opened !== undefined) {
    return <ArtifactDetail artifact={opened} hobName={hobName} onBack={() => setOpenId(null)} onJump={onJump} />;
  }
  const shown = filterArtifacts(all, filter);
  return (
    <div className="flex flex-col gap-3">
      <FilterChips
        aria-label={copy.filterLabel}
        value={filter}
        onValueChange={(value) => isArtifactFilter(value) && setFilter(value)}
      >
        {ARTIFACT_FILTERS.map((each) => (
          <FilterChip key={each} value={each} count={formatCount(filterArtifacts(all, each).length)}>
            {copy.filters[each]}
          </FilterChip>
        ))}
      </FilterChips>
      <ReadState
        read={artifacts}
        empty={shown.length > 0 ? undefined : all.length === 0 ? copy.empty : copy.emptyFilter}
      />
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {shown.map((artifact) => (
          <li key={artifact.id} className="flex items-center gap-2.5 rounded-control px-2 py-2 hover:bg-hover">
            <span
              aria-hidden
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-card text-meta text-text-secondary"
            >
              {KIND_ICON[artifact.kind]}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-ui font-semibold text-text-strong">{artifact.title}</span>
              <span className="truncate text-meta text-label">
                {copy.meta({
                  kind: copy.kind[artifact.kind],
                  version: artifact.latestVersion,
                  when: formatAgo(artifact.updatedAt),
                })}
              </span>
            </span>
            <Button
              variant="text"
              size="xs"
              aria-label={copy.openOf({ title: artifact.title })}
              onClick={() => setOpenId(artifact.id)}
            >
              {copy.open}
            </Button>
          </li>
        ))}
      </ul>
      <p className="m-0 text-meta text-label">{copy.footnote}</p>
    </div>
  );
}

function ArtifactDetail({
  artifact,
  hobName,
  onBack,
  onJump,
}: {
  artifact: Artifact;
  hobName: string;
  onBack: () => void;
  onJump: (messageId: MessageId) => void;
}) {
  const link = linkOf(artifact);
  const message = madeAt(artifact);
  return (
    <section aria-label={artifact.title} className="flex flex-col gap-3">
      <Button variant="text" size="xs" className="self-start" onClick={onBack}>
        {copy.back}
      </Button>
      <h3 className="m-0 text-title font-semibold text-text-strong">{artifact.title}</h3>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-ui">
        <dt className="text-label">{copy.where}</dt>
        <dd className="m-0 font-mono text-detail text-text">{artifact.locator}</dd>
        <dt className="text-label">{copy.madeBy}</dt>
        <dd className="m-0 text-text">{artifact.actor.kind === "user" ? copy.you : hobName}</dd>
        <dt className="text-label">{copy.version}</dt>
        <dd className="m-0 text-text">{formatCount(artifact.latestVersion)}</dd>
        <dt className="text-label">{copy.changed}</dt>
        <dd className="m-0 text-text">{formatAgo(artifact.updatedAt)}</dd>
      </dl>
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
