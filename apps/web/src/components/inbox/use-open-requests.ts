import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { roomSearch } from "../quest-room/room-search.ts";

/**
 * Opens in the Inbox each request the desktop app asks for, as when the user clicks its system
 * notification, and each Task it asks for in its lead's chat, where the room opens with that lane
 * lit (ADR 027). Outside the desktop app there is nothing to listen to.
 */
export const useOpenRequests = () => {
  const navigate = useNavigate();
  useEffect(
    () =>
      window.hobbots?.onOpenRequest?.((requestId) => {
        void navigate({ to: "/inbox", search: { tab: "needs", request: requestId } });
      }),
    [navigate],
  );
  useEffect(
    () =>
      window.hobbots?.onOpenTask?.(({ hobId, threadId, taskId }) => {
        void navigate({
          to: "/hobs/$hobId/threads/$threadId",
          params: { hobId, threadId },
          search: roomSearch(taskId),
        });
      }),
    [navigate],
  );
};
