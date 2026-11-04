import type { AttemptActivity, FileChange } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useState } from "react";
import { formatBytes } from "../../../lib/reply-steps.ts";
import type { HobLookup } from "../../quest/use-work.ts";
import { changeShow, fileKindLabel, sharedHobs } from "./changes-model.ts";
import { CodeDiffView } from "./code-diff-view.tsx";
import { DocumentView } from "./document-view.tsx";
import { ImageView } from "./image-view.tsx";
import { KindTag } from "./kind-tag.tsx";
import { messages } from "./messages.ts";
import { NotKeptNote } from "./not-kept-note.tsx";
import { sideText, type TextSide, useTextSide } from "./use-version.ts";

/**
 * One changed file: its path and how it changed, who else worked in its folder meanwhile, and its
 * before and after in the form that suits it (ADR 023).
 */
export function ChangeDetail({
  change,
  activity,
  live,
  hobs,
}: {
  change: FileChange;
  activity: AttemptActivity;
  /** The Attempt is running a turn, so a change not yet settled may change again. */
  live: boolean;
  hobs: HobLookup;
}) {
  const show = changeShow(change);
  const shared = sharedHobs(change, activity).map((id) => hobs(id).name);
  const cleared = activity.detailsClearedAt !== null;
  return (
    <article aria-label={change.path} className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="m-0 min-w-0 font-mono text-sm font-bold break-all text-moonlight">{change.path}</h3>
          <KindTag kind={change.kind} />
        </div>
        {change.movedFrom !== null && (
          <p className="m-0 text-detail text-secondary-text">{messages.movedFrom({ path: change.movedFrom })}</p>
        )}
        {change.sharedWith.length > 0 && (
          <p className="m-0 text-detail text-lantern">
            {shared.length > 0 ? messages.shared({ names: shared }) : messages.sharedUnknown}
          </p>
        )}
        {live && !change.settled && <p className="m-0 text-detail text-label">{messages.soFar}</p>}
      </header>
      {show === "document" || show === "code" ? (
        <TextChange change={change} activity={activity} cleared={cleared} document={show === "document"} />
      ) : show === "image" ? (
        <ImageView
          attemptId={activity.attempt.id}
          path={change.path}
          before={change.before}
          after={change.after}
          cleared={cleared}
        />
      ) : show === "link" ? (
        <p className="m-0 text-detail text-secondary-text">{messages.link}</p>
      ) : (
        <OtherFile change={change} />
      )}
    </article>
  );
}

/** A file Hobbots cannot show: its kind and size, before and after, and why its contents were not kept. */
function OtherFile({ change }: { change: FileChange }) {
  const kind = fileKindLabel(change.path);
  const size =
    change.before !== null && change.after !== null
      ? messages.sizes({ before: formatBytes(change.before.size), after: formatBytes(change.after.size) })
      : formatBytes((change.after ?? change.before)?.size ?? 0);
  const reason = (change.after ?? change.before)?.notKept ?? null;
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-detail text-secondary-text">{messages.other({ kind, size })}</p>
      {reason !== null && <NotKeptNote side={change.after === null ? "before" : "after"} reason={reason} />}
    </div>
  );
}

/** A text file's change: both versions read, then shown rendered (documents) or as a diff (code). */
function TextChange({
  change,
  activity,
  cleared,
  document,
}: {
  change: FileChange;
  activity: AttemptActivity;
  cleared: boolean;
  /** A document, shown rendered unless its source is asked for. */
  document: boolean;
}) {
  const [view, setView] = useState<"rendered" | "source">("rendered");
  const before = useTextSide(activity.attempt.id, change.before, cleared);
  const after = useTextSide(activity.attempt.id, change.after, cleared);
  const sides = [before, after];
  if (sides.some((side) => side.kind === "loading")) {
    return <p className="m-0 text-detail text-label">{messages.reading}</p>;
  }
  const failed = sides.find((side): side is Extract<TextSide, { kind: "failed" }> => side.kind === "failed");
  if (failed !== undefined) {
    return (
      <p className="m-0 flex items-center gap-3 text-detail text-secondary-text">
        <span>{messages.unread}</span>
        <Button variant="chip" size="xs" onClick={failed.retry}>
          {messages.tryAgain}
        </Button>
      </p>
    );
  }
  const was = sideText(before);
  const now = sideText(after);
  const onlyOneSide = (before.kind !== "none" && was === null) || (after.kind !== "none" && now === null);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {before.kind === "not-kept" && <NotKeptNote side="before" reason={before.reason} />}
      {after.kind === "not-kept" && <NotKeptNote side="after" reason={after.reason} />}
      {document && (was !== null || now !== null) && (
        <SegmentedControl size="sm" aria-label={messages.view} value={view} onValueChange={setView}>
          {(["rendered", "source"] as const).map((each) => (
            <SegmentedControlItem key={each} value={each}>
              {messages[each]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      )}
      {was === null && now === null ? null : document && view === "rendered" ? (
        <DocumentView before={was} after={now} />
      ) : (
        <CodeDiffView path={change.path} before={was} after={now} onlyOneSide={onlyOneSide} />
      )}
    </div>
  );
}
