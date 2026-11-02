import type { BackpackItem } from "@hobbots/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { taskTreeQuery } from "../../api/tasks.ts";

/**
 * Opens the Task an item is about in the drawer beside the chat its work started in: the thread of
 * its tree's top Task, whose owner leads it. An item about no Task, or one the hub no longer has,
 * opens nothing, and only the last item asked for opens, however the reads arrive.
 */
export const useOpenItem = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const latest = useRef(0);
  return async (item: BackpackItem) => {
    if (item.taskId === null) return;
    const asked = ++latest.current;
    const read = await queryClient.fetchQuery(taskTreeQuery(item.taskId)).catch(() => null);
    const rootId = read?.tree.tasks[0]?.rootId;
    if (rootId === undefined) return;
    const top =
      rootId === item.taskId
        ? read?.tree.tasks[0]
        : (await queryClient.fetchQuery(taskTreeQuery(rootId)).catch(() => null))?.tree.tasks[0];
    if (top?.threadId == null || asked !== latest.current) return;
    void navigate({
      to: "/hobs/$hobId/threads/$threadId",
      params: { hobId: top.ownerId, threadId: top.threadId },
      search: { task: item.taskId },
    });
  };
};
