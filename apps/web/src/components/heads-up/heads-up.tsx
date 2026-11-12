import type { Message, MessageId, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { clashesQuery } from "../../api/clashes.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { type HobLookup, useHobLookup } from "../quest/use-work.ts";
import { BEFORE_FIRST, type HeadsUp, headsUpOf, placeHeadsUps } from "./heads-up-model.ts";
import { messages } from "./messages.ts";

/**
 * A Heads-up in the chat or camp (ADR 037): two or more Tasks whose open claims on a path or branch
 * clash, as the hub's claims register found them, with whom each side belongs to and who claimed
 * last. The hub already told each lead; neither Task was stopped. It calls no model and reads no
 * transcript: the register is the record. It goes once the clash is gone.
 */
function HeadsUpCard({ headsUp, hobs }: { headsUp: HeadsUp; hobs: HobLookup }) {
  const title = messages.title[headsUp.scope]({ count: headsUp.sides.length });
  return (
    <section
      aria-label={title}
      className="mx-auto flex w-full max-w-bubble-max flex-col gap-2 rounded-card border-(length:--edge) border-dashed border-star bg-card px-4 py-3 text-ui"
    >
      <span className="flex items-center gap-2 font-semibold text-text-strong">
        <span aria-hidden className="text-star">
          {messages.mark}
        </span>
        {title}
      </span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {headsUp.sides.map((side) => (
          <li key={side.key} className="flex items-center gap-2 text-text-strong">
            <HobSprite hob={hobs(side.ownerId)} size={16} />
            <span className="min-w-0 wrap-anywhere">
              {messages.side({ name: hobs(side.ownerId).name, task: side.task, key: side.on })}
              {side.elsewhere && <span className="text-label"> · {messages.elsewhere}</span>}
            </span>
          </li>
        ))}
      </ul>
      <small className="text-meta text-label">
        {messages.spotted({ name: hobs(headsUp.spotted.ownerId).name, key: headsUp.spotted.on })}
      </small>
    </section>
  );
}

const NONE: ReadonlyArray<HeadsUp> = [];

/**
 * The Heads-ups of a chat's or camp's transcript, placed by time: `before` goes above the first
 * message, `after(id)` under the message with that id. A failed read says so at the end, with a way
 * to read again.
 */
export const useHeadsUps = (threadId: ThreadId | undefined, transcript: ReadonlyArray<Message>) => {
  const read = useQuery({ ...clashesQuery(threadId ?? ("" as ThreadId)), enabled: threadId !== undefined });
  const hobs = useHobLookup();
  const headsUps =
    threadId === undefined
      ? NONE
      : (read.data ?? []).flatMap((clash) => {
          const headsUp = headsUpOf(clash, threadId);
          return headsUp === null ? [] : [headsUp];
        });
  const placed = placeHeadsUps(transcript, headsUps);
  const at = (key: MessageId | typeof BEFORE_FIRST) =>
    placed.get(key)?.map((headsUp) => <HeadsUpCard key={headsUp.key} headsUp={headsUp} hobs={hobs} />) ?? null;
  return {
    before: at(BEFORE_FIRST),
    after: (messageId: MessageId) => at(messageId),
    failed:
      read.isError && read.data === undefined ? (
        <p role="alert" className="m-0 flex items-center justify-center gap-2 text-detail text-rose">
          {messages.unread}
          <Button variant="ghost" size="xs" onClick={() => void read.refetch()}>
            {messages.retry}
          </Button>
        </p>
      ) : null,
  };
};
