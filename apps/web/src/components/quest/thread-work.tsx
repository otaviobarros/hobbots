import type { AgentId, Message, MessageId, TaskTree, ThreadId } from "@hobbots/domain";
import { useOpenRoom } from "../quest-room/room-search.ts";
import { QuestButtons } from "./quest-button.tsx";
import { type Pins, useFollowedTrees, useHobLookup, useThreadTrees } from "./use-work.ts";
import { BEFORE_ALL, liveTrees, placeMoments } from "./work-model.ts";
import { WorkMoments } from "./work-moments.tsx";

/**
 * The quest buttons in a thread's chat header: each Quest pinned from another thread, then this
 * thread's work while it runs or while it is pinned.
 */
export function ThreadQuestButton({ hobId, threadId, pins }: { hobId: AgentId; threadId: ThreadId; pins: Pins }) {
  const { thread, elsewhere } = useFollowedTrees(threadId, pins.pinned);
  const open = useOpenRoom(hobId, threadId);
  const pinned = (tree: TaskTree) => tree.tasks[0] !== undefined && pins.pinned.includes(tree.tasks[0].id);
  const live = new Set(liveTrees(thread));
  const shown = [...elsewhere, ...thread.filter((tree) => live.has(tree) || pinned(tree))];
  return <QuestButtons trees={shown} onOpen={(taskId) => open(taskId)} />;
}

/**
 * The work moments of a thread's transcript, placed by time: `before` goes above the first message,
 * `after(id)` under the message with that id.
 */
export const useWorkMoments = (hobId: AgentId, threadId: ThreadId | undefined, transcript: ReadonlyArray<Message>) => {
  const trees = useThreadTrees(threadId);
  const hobs = useHobLookup();
  const open = useOpenRoom(hobId, threadId ?? ("" as ThreadId));
  const placed = placeMoments(transcript, trees);
  const at = (key: MessageId | typeof BEFORE_ALL) => {
    const moments = placed.get(key);
    return moments === undefined ? null : <WorkMoments moments={moments} hobs={hobs} onOpen={open} />;
  };
  return { before: at(BEFORE_ALL), after: (messageId: MessageId) => at(messageId) };
};
