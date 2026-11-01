import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Opens in the Inbox each request the desktop app asks for, as when the user clicks its system
 * notification. Outside the desktop app there is nothing to listen to.
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
};
