import type { Agent, ApprovalRequest, HobbotsEvent } from "@hobbots/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { inboxQuery } from "../../api/approvals.ts";
import { agentsQuery, archivedAgentsQuery } from "../../api/queries.ts";
import { messages } from "./messages.ts";
import { noticeChange, requestNotice } from "./request-notices.ts";

/** Whether the system shows this window's notifications: the desktop app, once it may. */
const mayNotify = async (): Promise<boolean> => {
  if (window.hobbots === undefined || typeof Notification === "undefined") return false;
  if (Notification.permission === "default") await Notification.requestPermission();
  return Notification.permission === "granted";
};

/**
 * The handler for live events that sends a system notification when a new request needs the user
 * while the desktop window is not focused. Clicking it brings the window forward and opens the
 * request in the Inbox; it closes on its own once the request is decided, wherever that happens.
 */
export const useRequestNotices = (): ((event: HobbotsEvent) => void) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const shown = useRef(new Map<string, Notification>());

  const hobName = (approval: ApprovalRequest) => {
    const hobs = [
      ...(queryClient.getQueryData<ReadonlyArray<Agent>>(agentsQuery.queryKey) ?? []),
      ...(queryClient.getQueryData<ReadonlyArray<Agent>>(archivedAgentsQuery.queryKey) ?? []),
    ];
    return hobs.find((hob) => hob.id === approval.agentId)?.name ?? messages.unknownHob;
  };

  const show = async (approval: ApprovalRequest) => {
    if (document.hasFocus() || !(await mayNotify())) return;
    const { title, body } = requestNotice(approval, hobName(approval));
    const notice = new Notification(title, { body, tag: approval.id });
    notice.onclick = () => {
      window.focus();
      void window.hobbots?.showWindow?.();
      void navigate({ to: "/inbox", search: { tab: "needs", request: approval.id } });
      notice.close();
    };
    shown.current.set(approval.id, notice);
  };

  return (event) => {
    const id = event._tag === "ApprovalRequested" || event._tag === "ApprovalResolved" ? event.approval.id : undefined;
    const current = queryClient
      .getQueryData<ReadonlyArray<ApprovalRequest>>(inboxQuery.queryKey)
      ?.find((approval) => approval.id === id);
    const change = noticeChange(event, current);
    if (change === undefined) return;
    if ("show" in change) {
      void show(change.show);
      return;
    }
    shown.current.get(change.close)?.close();
    shown.current.delete(change.close);
  };
};
