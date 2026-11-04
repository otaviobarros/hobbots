import type { AttemptActivity, FileChange } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { useState } from "react";
import { formatBytes } from "../../../lib/format.ts";
import type { HobLookup } from "../../quest/use-work.ts";
import { changeShow, fileKindLabel, sharedHobs, splitPath } from "./changes-model.ts";
import { CodeDiffView } from "./code-diff-view.tsx";
import { DocumentView } from "./document-view.tsx";
import { ImageView } from "./image-view.tsx";
import { KindTag } from "./kind-tag.tsx";
import { messages } from "./messages.ts";
import { NotKeptNote } from "./not-kept-note.tsx";
import { sideText, type TextSide, useTextSide } from "./use-version.ts";

/**
 * One changed file: its name with its folder under it and how it changed, who else worked in its
 * folder meanwhile, whether it may still change, and its before and after in the form that suits it
 * (ADR 023). A document opens rendered, with Source one click away.
 */
export function ChangeDetail({
  change,
  activity,
  live,
  hobs,
  onOpenFiles,
}: {
  change: FileChange;
  activity: AttemptActivity;
  /** The Attempt is running a turn, so a change not yet settled may change again. */
  live: boolean;
  hobs: HobLookup;
  /** Opens the same file in Files, for a change that left one there. */
  onOpenFiles: (() => void) | null;
}) {
  const [view, setView] = useState<DocumentShow>("rendered");
  const show = changeShow(change);
  const shared = sharedHobs(change, activity).map((id) => hobs(id).name);
  const cleared = activity.detailsClearedAt !== null;
  const { dir, name } = splitPath(change.path);
  return (
    <article aria-label={change.path} className="flex min-w-0 flex-col gap-2.5">
      <header className="flex flex-col gap-2.5">
        <div className="flex min-h-[30px] min-w-0 flex-wrap items-center gap-2">
          <span className="flex min-w-0 flex-col">
            <h3 className="m-0 font-mono text-[13.5px] leading-5 font-semibold break-all text-text-strong">{name}</h3>
            {dir !== "" && <span className="font-mono text-[11px] leading-[15px] text-label">{dir}</span>}
          </span>
          <KindTag kind={change.kind} />
          <span className="flex-1" />
          {show === "document" && (
            <SegmentedControl size="sm" aria-label={messages.showAs} value={view} onValueChange={setView}>
              {(["rendered", "source"] as const).map((each) => (
                <SegmentedControlItem key={each} value={each}>
                  {messages[each]}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          )}
          {onOpenFiles !== null && (
            <Button variant="ghost" size="xs" onClick={onOpenFiles}>
              {messages.openInFiles}
            </Button>
          )}
        </div>
        {change.movedFrom !== null && (
          <p className="m-0 text-detail text-text-secondary">{messages.movedFrom({ path: change.movedFrom })}</p>
        )}
        {change.sharedWith.length > 0 && (
          <SharedWarning>
            {shared.length > 0 ? messages.shared({ names: shared }) : messages.sharedUnknown}
          </SharedWarning>
        )}
        {live && !change.settled && (
          <p className="m-0 flex items-center gap-2 text-detail text-lantern">
            <span
              aria-hidden
              className="size-2 shrink-0 animate-hb-blink rounded-dot bg-lantern motion-reduce:animate-none"
            />
            {messages.soFar}
          </p>
        )}
        {change.kind === "deleted" && <p className="m-0 text-detail text-text-secondary">{messages.deletedHeld}</p>}
      </header>
      {show === "document" || show === "code" ? (
        <TextChange
          change={change}
          activity={activity}
          cleared={cleared}
          rendered={show === "document" && view === "rendered"}
        />
      ) : show === "image" ? (
        <ImageView
          attemptId={activity.attempt.id}
          path={change.path}
          before={change.before}
          after={change.after}
          cleared={cleared}
        />
      ) : show === "link" ? (
        <p className="m-0 text-detail text-text-secondary">{messages.link}</p>
      ) : (
        <OtherFile change={change} />
      )}
    </article>
  );
}

type DocumentShow = "rendered" | "source";

/** "Changed while Ada was also working here." on a lantern wash, with a round warning mark. */
function SharedWarning({ children }: { children: string }) {
  return (
    <p className="m-0 flex items-start gap-2.5 rounded-control bg-lantern/13 px-3 py-2 text-detail text-text">
      <span
        aria-hidden
        className="grid size-[18px] shrink-0 place-items-center rounded-full bg-lantern text-xs font-bold text-on-lantern"
      >
        !
      </span>
      <span>{children}</span>
    </p>
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
      <p className="m-0 text-detail text-text-secondary">{messages.other({ kind, size })}</p>
      {reason !== null && <NotKeptNote side={change.after === null ? "before" : "after"} reason={reason} />}
    </div>
  );
}

/** A text file's change: both versions read, then shown rendered (documents) or as a diff. */
function TextChange({
  change,
  activity,
  cleared,
  rendered,
}: {
  change: FileChange;
  activity: AttemptActivity;
  cleared: boolean;
  /** A document shown rendered, not as its source. */
  rendered: boolean;
}) {
  const before = useTextSide(activity.attempt.id, change.before, cleared);
  const after = useTextSide(activity.attempt.id, change.after, cleared);
  const sides = [before, after];
  if (sides.some((side) => side.kind === "loading")) {
    return <p className="m-0 text-detail text-label">{messages.reading}</p>;
  }
  const failed = sides.find((side): side is Extract<TextSide, { kind: "failed" }> => side.kind === "failed");
  if (failed !== undefined) {
    return (
      <p className="m-0 flex items-center gap-3 text-detail text-text-secondary">
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
      {was === null && now === null ? null : rendered ? (
        <DocumentView before={was} after={now} />
      ) : (
        <CodeDiffView path={change.path} before={was} after={now} onlyOneSide={onlyOneSide} />
      )}
    </div>
  );
}
