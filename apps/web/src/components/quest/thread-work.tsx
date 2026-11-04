import type { AgentId, Message, MessageId, ThreadId } from "@hobbots/domain";
import { useOpenWorkbench } from "../workbench/use-workbench.ts";
import { QuestButtons } from "./quest-button.tsx";
import { useHobLookup, useOpenQuest, useOpenTask, useThreadTrees } from "./use-work.ts";
import { BEFORE_ALL, placeMoments } from "./work-model.ts";
import { WorkMoments } from "./work-moments.tsx";

/** The quest button in a thread's chat header while its work runs. */
export function ThreadQuestButton({ hobId, threadId }: { hobId: AgentId; threadId: ThreadId }) {
  const trees = useThreadTrees(threadId);
  const open = useOpenQuest(hobId, threadId);
  return <QuestButtons trees={trees} onOpen={open} />;
}

/**
 * The work moments of a thread's transcript, placed by time: `before` goes above the first message,
 * `after(id)` under the message with that id.
 */
export const useWorkMoments = (hobId: AgentId, threadId: ThreadId | undefined, transcript: ReadonlyArray<Message>) => {
  const trees = useThreadTrees(threadId);
  const hobs = useHobLookup();
  const open = useOpenTask(hobId, threadId ?? ("" as ThreadId));
  const openQuest = useOpenQuest(hobId, threadId ?? ("" as ThreadId));
  const openWorkbench = useOpenWorkbench(hobId, threadId ?? ("" as ThreadId));
  const placed = placeMoments(transcript, trees);
  const at = (key: MessageId | typeof BEFORE_ALL) => {
    const moments = placed.get(key);
    return moments === undefined ? null : (
      <WorkMoments moments={moments} hobs={hobs} onOpen={open} onQuest={openQuest} onWorkbench={openWorkbench} />
    );
  };
  return { before: at(BEFORE_ALL), after: (messageId: MessageId) => at(messageId) };
};
