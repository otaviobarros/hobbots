import { type Artifact, artifactShow, type ThreadId } from "@hobbots/domain";
import { useState } from "react";
import { artifactContentUrl } from "../../api/records.ts";
import { firstLines } from "./artifact-flow.ts";
import { useVersionText } from "./use-artifact-content.ts";

const KIND_ICON: Readonly<Record<Artifact["kind"], string>> = {
  code: "</>",
  page: "▤",
  doc: "¶",
  email: "✉",
  image: "▣",
  pr: "⑂",
  file: "▢",
};

/** A row's mark: a thumbnail of an image's latest version, else the glyph of its kind. */
export function RowMark({ threadId, artifact }: { threadId: ThreadId; artifact: Artifact }) {
  const [broken, setBroken] = useState(false);
  if (artifactShow(artifact) === "image" && !broken) {
    return (
      <img
        src={artifactContentUrl(threadId, artifact.id, artifact.latestVersion)}
        alt=""
        onError={() => setBroken(true)}
        className="size-10 shrink-0 rounded-control border border-line bg-card object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-card text-meta text-text-secondary"
    >
      {KIND_ICON[artifact.kind]}
    </span>
  );
}

/** A row's short preview (#1434): the first lines of a document, code or page at its latest version. */
export function RowPreview({ threadId, artifact }: { threadId: ThreadId; artifact: Artifact }) {
  const show = artifactShow(artifact);
  const text = show === "document" || show === "diff" || show === "page";
  const read = useVersionText(
    threadId,
    artifact.id,
    text ? { version: artifact.latestVersion, content: "unknown" } : null,
  );
  if (read.kind !== "read") return null;
  const lines = firstLines(read.value, show === "document");
  if (lines.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-col text-meta text-text-secondary">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one read never reorder
        <span key={index} className="truncate">
          {line}
        </span>
      ))}
    </span>
  );
}
