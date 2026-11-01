import type { ApprovalRequest } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { inboxQuery } from "../../api/approvals.ts";
import { freshRequests, requestNotice } from "./request-notices.ts";
import { useInboxDirectory } from "./use-inbox-directory.ts";

const NONE: ReadonlyArray<ApprovalRequest> = [];

/** Whether the system shows this window's notifications: the desktop app, once it may. */
const mayNotify = async (): Promise<boolean> => {
  if (window.hobbots === undefined || typeof Notification === "undefined") return false;
  if (Notification.permission === "default") await Notification.requestPermission();
  return Notification.permission === "granted";
};

/**
 * Sends a system notification when a new request needs the user while the desktop window is not
 * focused. Clicking it brings the window forward and opens the request in the Inbox; it closes on
 * its own once the request is decided, wherever that happens.
 */
export const useRequestNotices = () => {
  const approvals = useQuery(inboxQuery).data ?? NONE;
  const directory = useInboxDirectory(approvals);
  const hobName = useRef(directory.hobName);
  hobName.current = directory.hobName;
  const navigate = useNavigate();
  const seen = useRef<ReadonlySet<string> | undefined>(undefined);
  const shown = useRef(new Map<string, Notification>());
  const loaded = approvals !== NONE;

  useEffect(() => {
    if (!loaded) return;
    const next = freshRequests(seen.current, approvals);
    seen.current = next.seen;
    for (const [id, notice] of shown.current) {
      if (!approvals.some((approval) => approval.id === id && approval.state === "pending")) {
        notice.close();
        shown.current.delete(id);
      }
    }
    if (next.fresh.length === 0 || document.hasFocus()) return;
    void mayNotify().then((allowed) => {
      if (!allowed) return;
      for (const approval of next.fresh) {
        const { title, body } = requestNotice(approval, hobName.current(approval.agentId));
        const notice = new Notification(title, { body, tag: approval.id });
        notice.onclick = () => {
          window.focus();
          void window.hobbots?.showWindow?.();
          void navigate({ to: "/inbox", search: { tab: "needs", request: approval.id } });
          notice.close();
        };
        shown.current.set(approval.id, notice);
      }
    });
  }, [approvals, loaded, navigate]);
};
