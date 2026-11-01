import type { AgentId, Message, MessageId, ThreadId } from "@hobbots/domain";
import { QuestStrip } from "./quest-strip.tsx";
import { useHobLookup, useOpenTask, useThreadTrees } from "./use-work.ts";
import { BEFORE_ALL, placeMoments } from "./work-model.ts";
import { WorkMoments } from "./work-moments.tsx";

/** The strip under a thread's chat header while its work runs. */
export function ThreadWorkStrip({ hobId, threadId }: { hobId: AgentId; threadId: ThreadId }) {
  const trees = useThreadTrees(threadId);
  const hobs = useHobLookup();
  const open = useOpenTask(hobId, threadId);
  return <QuestStrip trees={trees} hobs={hobs} onOpen={open} />;
}

/**
 * The work moments of a thread's transcript, placed by time: `before` goes above the first message,
 * `after(id)` under the message with that id.
 */
export const useWorkMoments = (hobId: AgentId, threadId: ThreadId | undefined, transcript: ReadonlyArray<Message>) => {
  const trees = useThreadTrees(threadId);
  const hobs = useHobLookup();
  const open = useOpenTask(hobId, threadId ?? ("" as ThreadId));
  const placed = placeMoments(transcript, trees);
  const at = (key: MessageId | typeof BEFORE_ALL) => {
    const moments = placed.get(key);
    return moments === undefined ? null : <WorkMoments moments={moments} hobs={hobs} onOpen={open} />;
  };
  return { before: at(BEFORE_ALL), after: (messageId: MessageId) => at(messageId) };
};
