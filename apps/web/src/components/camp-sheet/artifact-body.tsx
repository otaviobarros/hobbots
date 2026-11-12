import type { Artifact, ArtifactShow, ArtifactVersion, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useState } from "react";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { CodeDiffView } from "../workbench/changes/code-diff-view.tsx";
import { pageDocument } from "./artifact-flow.ts";
import { messages } from "./messages.ts";
import { useVersionImage, useVersionText, type VersionRead, type VersionText } from "./use-artifact-content.ts";

const copy = messages.artifacts;

/** What one shown version is drawn from: the artifact, how it is shown, the version and the one before it. */
interface Shown {
  readonly threadId: ThreadId;
  readonly artifact: Artifact;
  readonly show: ArtifactShow;
  readonly version: ArtifactVersion;
  /** The newest earlier version with contents, which code and a source compare against; null for none. */
  readonly before: ArtifactVersion | null;
}

/**
 * One version of an artifact, drawn by its kind (#1434), the same in the sheet and the full viewer: a
 * document rendered, with its source as a diff one click away; code and text as a diff against the
 * version before; a page in a frame without scripts, with its source; an image; a link as a card.
 */
export function ArtifactBody(props: Shown) {
  switch (props.show) {
    case "image":
      return <ImageVersion {...props} />;
    case "link":
      return <LinkCard locator={props.artifact.locator} />;
    case "none":
      return <p className="m-0 text-ui text-text-secondary">{copy.cannotShow}</p>;
    default:
      return <TextVersion {...props} />;
  }
}

type View = "rendered" | "source";

function TextVersion({ threadId, artifact, show, version, before }: Shown) {
  const [view, setView] = useState<View>("rendered");
  const now = useVersionText(threadId, artifact.id, version);
  const was = useVersionText(threadId, artifact.id, before);
  if (now.kind !== "read") return <ReadNote read={now} />;
  const source = show === "diff" || view === "source";
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {show !== "diff" && (
        <SegmentedControl size="sm" aria-label={copy.showAs} value={view} onValueChange={setView}>
          {(["rendered", "source"] as const).map((each) => (
            <SegmentedControlItem key={each} value={each}>
              {copy[each]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      )}
      {source ? (
        <SourceDiff title={artifact.title} text={now.value} was={was} before={before} />
      ) : show === "page" ? (
        <iframe
          title={copy.pageOf({ title: artifact.title })}
          sandbox=""
          srcDoc={pageDocument(now.value)}
          className="h-96 w-full rounded-card border border-line"
        />
      ) : (
        <article
          aria-label={copy.preview({ title: artifact.title })}
          className="min-w-0 rounded-card border border-line bg-card px-4 pt-3 pb-3.5"
        >
          <ReplyMarkdown content={now.value} streaming={false} caret={false} />
        </article>
      )}
    </div>
  );
}

/** A version's text as a diff against the version before it, or whole when there is none to read. */
function SourceDiff({
  title,
  text,
  was,
  before,
}: {
  title: string;
  text: string;
  was: VersionText;
  before: ArtifactVersion | null;
}) {
  const earlier = was.kind === "read" ? was.value : null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {before !== null && earlier !== null && (
        <p className="m-0 text-meta text-label">{copy.comparedWith({ version: before.version })}</p>
      )}
      <CodeDiffView path={title} before={earlier} after={text} onlyOneSide={earlier === null} />
    </div>
  );
}

/** What a read that holds no text yet says: reading, failed with Read again, or why it is not shown. */
function ReadNote({ read }: { read: VersionRead<unknown> }) {
  switch (read.kind) {
    case "loading":
      return <p className="m-0 text-ui text-label">{copy.reading}</p>;
    case "failed":
      return (
        <p className="m-0 flex flex-wrap items-center gap-3 text-ui text-text-secondary">
          <span>{copy.unread}</span>
          <Button variant="chip" size="xs" onClick={read.retry}>
            {copy.readAgain}
          </Button>
        </p>
      );
    case "refused":
      return <p className="m-0 text-ui text-text-secondary">{copy.unavailable[read.reason]}</p>;
    default:
      return null;
  }
}

/** An image version, drawn once its bytes are read, or what its read says instead. */
function ImageVersion({ threadId, artifact, version }: Shown) {
  const image = useVersionImage(threadId, artifact.id, artifact.locator, version);
  if (image.kind !== "read") return <ReadNote read={image} />;
  return (
    <img
      src={image.value}
      alt={copy.imageOf({ title: artifact.title, version: version.version })}
      className="max-h-96 max-w-full self-start rounded-card border border-line bg-panel object-contain"
    />
  );
}

/** A link as a card: where it goes, opened in the browser. */
function LinkCard({ locator }: { locator: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-line bg-card px-4 py-3">
      <span className="font-mono text-detail break-all text-text-strong">{locator}</span>
      <span className="text-meta text-label">{copy.linkNote}</span>
    </div>
  );
}
