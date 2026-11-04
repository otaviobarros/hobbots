import type { AttemptId, FileVersion } from "@hobbots/domain";
import { useState } from "react";
import { attemptContentUrl } from "../../../api/workbench.ts";
import { formatBytes } from "../../../lib/reply-steps.ts";
import { messages } from "./messages.ts";
import { NotKeptNote } from "./not-kept-note.tsx";

/**
 * An image's change: the earlier and the later version side by side where both were kept. A version
 * that was not kept says why in its place, so a deleted or overwritten image past the size limit
 * reads "Earlier version not kept: too large".
 */
export function ImageView({
  attemptId,
  path,
  before,
  after,
  cleared,
}: {
  attemptId: AttemptId;
  path: string;
  before: FileVersion | null;
  after: FileVersion | null;
  cleared: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
      {before !== null && (
        <Side
          title={messages.before}
          side="before"
          alt={messages.image.before({ path })}
          attemptId={attemptId}
          version={before}
          cleared={cleared}
        />
      )}
      {after !== null && (
        <Side
          title={messages.after}
          side="after"
          alt={messages.image.after({ path })}
          attemptId={attemptId}
          version={after}
          cleared={cleared}
        />
      )}
    </div>
  );
}

function Side({
  title,
  side,
  alt,
  attemptId,
  version,
  cleared,
}: {
  title: string;
  side: "before" | "after";
  alt: string;
  attemptId: AttemptId;
  version: FileVersion;
  cleared: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const contentId = cleared ? null : version.contentId;
  return (
    <figure className="cut m-0 flex min-w-0 flex-col gap-2 bg-panel px-4 py-3">
      <figcaption className="flex items-baseline gap-2">
        <span className="font-pixel text-xs font-bold tracking-widest text-label uppercase">{title}</span>
        <span className="text-meta text-label">{formatBytes(version.size)}</span>
      </figcaption>
      {contentId === null ? (
        <NotKeptNote side={side} reason={version.contentId === null ? (version.notKept ?? "unreadable") : "cleared"} />
      ) : failed ? (
        <p className="m-0 text-detail text-text-secondary">{messages.image.failed}</p>
      ) : (
        <img
          src={attemptContentUrl(attemptId, contentId)}
          alt={alt}
          onError={() => setFailed(true)}
          className="max-h-120 max-w-full self-start object-contain"
        />
      )}
    </figure>
  );
}
