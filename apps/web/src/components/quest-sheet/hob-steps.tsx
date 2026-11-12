import { Button } from "@hobbots/ui/components/button";
import { useState } from "react";
import { LaneItemRow } from "../lanes/lane-items.tsx";
import type { Lane } from "../lanes/lane-model.ts";
import { messages } from "../lanes/messages.ts";
import type { LaneReads } from "../lanes/use-lane-room.ts";
import { HubWait } from "../loading/hub-wait.tsx";
import type { HobLookup } from "../quest/use-work.ts";

/**
 * What a hob did on the quest, in everyday words and in order, under its Tasks in the quest's sheet.
 * Once the quest has ended it folds to the hob's results until opened. The exact commands and files
 * are in the Workbench.
 */
export function HobSteps({
  lane,
  hobs,
  finished,
  reads,
}: {
  lane: Lane;
  hobs: HobLookup;
  finished: boolean;
  reads: LaneReads;
}) {
  const hob = hobs(lane.hobId);
  const [opened, setOpened] = useState(false);
  const all = lane.plain;
  const results = all.filter((item) => item.kind === "result");
  const folded = finished && !opened && results.length > 0 && results.length < all.length;
  const shown = folded ? results : all;
  return (
    <>
      {shown.length > 0 && (
        <ol aria-label={messages.did({ name: hob.name })} className="m-0 flex list-none flex-col gap-1.5 p-0">
          {shown.map((item) => (
            <LaneItemRow key={item.key} item={item} hobs={hobs} />
          ))}
        </ol>
      )}
      {folded && (
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setOpened(true)}>
          {messages.showSteps({ count: all.length - results.length })}
        </Button>
      )}
      {reads.failed ? (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-x-2 text-detail text-rose">
          {messages.unread({ name: hob.name })}
          <Button variant="ghost" size="xs" onClick={reads.retry}>
            {messages.tryAgain}
          </Button>
        </p>
      ) : (
        <HubWait pending={reads.pending} onRetry={reads.retry} />
      )}
    </>
  );
}
