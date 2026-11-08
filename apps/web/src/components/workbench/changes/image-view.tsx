import type { AttemptActivity, FileVersion } from "@hobbots/domain";
import { useState } from "react";
import { attemptContentUrl } from "../../../api/workbench.ts";
import { formatBytes } from "../../../lib/format.ts";
import { messages } from "./messages.ts";
import { NotKeptNote } from "./not-kept-note.tsx";
import type { KeptChange } from "./task-changes.ts";

/**
 * An image's change: the earlier and the later version side by side where both were kept. A version
 * that was not kept says why in its place, so a deleted or overwritten image past the size limit
 * reads "Earlier version not kept: too large".
 */
export function ImageView({ item }: { item: KeptChange }) {
  const { path, before, after } = item.change;
  return (
    <div className="grid min-w-0 gap-3 @min-[720px]:grid-cols-2">
      {before !== null && (
        <Side
          title={messages.before}
          side="before"
          alt={messages.image.before({ path })}
          keptIn={item.beforeIn}
          version={before}
        />
      )}
      {after !== null && (
        <Side
          title={messages.after}
          side="after"
          alt={messages.image.after({ path })}
          keptIn={item.afterIn}
          version={after}
        />
      )}
    </div>
  );
}

function Side({
  title,
  side,
  alt,
  keptIn,
  version,
}: {
  title: string;
  side: "before" | "after";
  alt: string;
  /** The records of the Attempt that kept this version. */
  keptIn: AttemptActivity;
  version: FileVersion;
}) {
  const [failed, setFailed] = useState(false);
  const contentId = keptIn.detailsClearedAt !== null ? null : version.contentId;
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2 rounded-card border border-line bg-card px-4 pt-3 pb-3.5">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="lbl text-meta font-bold text-label">{title}</span>
        <span className="text-meta text-label">{formatBytes(version.size)}</span>
      </figcaption>
      {contentId === null ? (
        <NotKeptNote side={side} reason={version.contentId === null ? (version.notKept ?? "unreadable") : "cleared"} />
      ) : failed ? (
        <p className="m-0 text-detail text-text-secondary">{messages.image.failed}</p>
      ) : (
        <img
          src={attemptContentUrl(keptIn.attempt.id, contentId)}
          alt={alt}
          onError={() => setFailed(true)}
          className="max-h-120 max-w-full self-start object-contain"
        />
      )}
    </figure>
  );
}
