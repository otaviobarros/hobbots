import { type Artifact, type ArtifactVersion, artifactShow, type ThreadId } from "@hobbots/domain";
import { FilterChip, FilterChips } from "@hobbots/ui/components/filter-chips";
import { useQuery } from "@tanstack/react-query";
import { artifactVersionsQuery } from "../../api/records.ts";
import { formatAgo } from "../../lib/format.ts";
import { ArtifactBody } from "./artifact-body.tsx";
import { shownVersion, versionBefore } from "./artifact-flow.ts";
import { ReviewActions, reviewLine } from "./artifact-review.tsx";
import { messages } from "./messages.ts";
import { ReadState } from "./sheet-parts.tsx";

const copy = messages.artifacts;

/**
 * An open artifact (#1434), the same in the sheet and the full viewer: what it is and who made it,
 * its versions to pick from, the picked one drawn by its kind, and its review, which you settle here
 * (#1422).
 */
export function ArtifactPanel({
  threadId,
  artifact,
  hobName,
  picked,
  onPick,
}: {
  threadId: ThreadId;
  artifact: Artifact;
  hobName: string;
  /** The version picked, or null for the latest. */
  picked: number | null;
  onPick: (version: number) => void;
}) {
  const read = useQuery(artifactVersionsQuery(threadId, artifact.id));
  const versions = read.data?.versions;
  const shown = shownVersion(versions, picked);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="m-0 text-meta text-label">
        {copy.meta({
          kind: copy.kind[artifact.kind],
          version: artifact.latestVersion,
          when: formatAgo(artifact.updatedAt),
        })}
        {" · "}
        {artifact.actor.kind === "user" ? copy.you : hobName}
      </p>
      {versions !== undefined && versions.length > 1 && shown !== null && (
        <Versions versions={versions} shown={shown} onPick={onPick} />
      )}
      {shown === null ? (
        <ReadState read={read} empty={undefined} />
      ) : (
        <ArtifactBody
          // A version is drawn afresh, so a source view picked on one does not stick to another.
          key={shown.version}
          threadId={threadId}
          artifact={artifact}
          show={read.data?.show ?? artifactShow(artifact)}
          version={shown}
          before={versions === undefined ? null : versionBefore(versions, shown)}
        />
      )}
      <p className="m-0 text-ui text-text">
        <span className="text-label">{copy.review.label}</span> {reviewLine(artifact, hobName)}
      </p>
      <ReviewActions threadId={threadId} artifact={artifact} />
    </div>
  );
}

/** The artifact's versions, newest first, one picked; older ones live here, never as rows of their own. */
function Versions({
  versions,
  shown,
  onPick,
}: {
  versions: ReadonlyArray<ArtifactVersion>;
  shown: ArtifactVersion;
  onPick: (version: number) => void;
}) {
  const latest = versions[0]?.version;
  return (
    <div className="flex flex-col gap-1.5">
      <FilterChips
        aria-label={copy.versions}
        value={String(shown.version)}
        onValueChange={(value) => onPick(Number(value))}
      >
        {versions.map((each) => (
          <FilterChip
            key={each.version}
            value={String(each.version)}
            aria-label={copy.versionName({
              version: each.version,
              when: formatAgo(each.at),
              latest: each.version === latest,
            })}
          >
            {copy.versionChip({ version: each.version })}
          </FilterChip>
        ))}
      </FilterChips>
      <p className="m-0 text-meta text-label">
        {copy.showing({ version: shown.version, total: versions.length })} · {formatAgo(shown.at)}
      </p>
    </div>
  );
}
