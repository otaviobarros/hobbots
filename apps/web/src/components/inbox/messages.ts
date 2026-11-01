import { INBOX_HISTORY } from "@hobbots/domain";
import { formatCount, formatIn, plural } from "../../lib/format.ts";

/** User-facing copy for the Inbox page and the Needs you counts (STD-I18N-001). */
export const messages = {
  title: "Inbox",
  intro: "Who is waiting on whom",
  tabsLabel: "Inbox filters",
  tabs: { needs: "Needs you", all: "All", history: "History" },
  listLabel: "Requests",
  waiting: ({ count }: { count: number }) =>
    plural(count, {
      one: `${formatCount(count)} request needs you`,
      other: `${formatCount(count)} requests need you`,
    }),
  from: ({ name }: { name: string }) => `${name} → you`,
  group: ({ name, thread }: { name: string; thread: string }) => `${name} · ${thread}`,
  untitledThread: "A thread",
  unknownHob: "A hob",
  kind: { approval: "Approval", expired: "Expired" },
  status: {
    pending: ({ expiry }: { expiry: string }) => `Waiting on you · ${expiry}`,
    pendingNoExpiry: "Waiting on you",
    approved: "You allowed this",
    approvedAlways: "You allowed this always",
    denied: "You denied this",
    expired: "Expired · nothing ran",
  },
  expiry: {
    soon: "expires in under a minute",
    minutes: ({ count }: { count: number }) => `expires ${formatIn(count, "minute")}`,
    hours: ({ count }: { count: number }) => `expires ${formatIn(count, "hour")}`,
  },
  allClear: "Nothing needs you",
  allClearHint: "Your hobs are working. New approvals land here.",
  emptyAll: "No requests yet",
  emptyAllHint: "When a hob asks permission, the request shows here with what you decided.",
  emptyHistory: "No decisions yet",
  emptyHistoryHint: "Requests you allow or deny, and ones that expire, show here.",
  pickOne: "Pick a request to see what it would do.",
  loadingRequest: "Reading the request…",
  loading: "Reading the Inbox…",
  failed: "Hobbots could not read the Inbox.",
  requestFailed: "Hobbots could not read this request. It stays open here until you try again or pick another.",
  retry: "Try again",
  detail: {
    label: ({ name, action }: { name: string; action: string }) => `Request from ${name}: ${action}`,
    thread: "Thread",
    asked: "Asked",
    expires: "Expires",
    expiresLead: ({ expiry, name }: { expiry: string; name: string }) =>
      `It ${expiry}. After that ${name} has to ask again.`,
    decided: "Decided",
    openChat: "Open in the chat",
    expiredFoot: "Expired requests can never be approved late. The hob asks again with what is true now.",
    pendingFoot: ({ name }: { name: string }) =>
      `${name} can only do what is listed here. Anything else asks again. Deciding here works the same as in the chat.`,
  },
  history: {
    heading: "Decision history",
    title: "What you allowed and denied",
    intro: `Your latest ${formatCount(INBOX_HISTORY)} decisions, most recent first, with who asked and what it was for.`,
    verdict: { once: "Once", always: "Always", quest: "Quest", denied: "Denied", expired: "Expired" },
    meta: ({ when, thread }: { when: string; thread: string }) => `${when} · ${thread}`,
    action: ({ name, action }: { name: string; action: string }) => `${name}: ${action}`,
  },
  home: {
    more: ({ count }: { count: number }) => `${formatCount(count)} more in the Inbox`,
    empty:
      "Nothing needs you right now. When a hob asks permission or has a question, it waits here and you can open it in the Inbox.",
    open: "Open the Inbox",
  },
  rail: ({ count }: { count: number }) =>
    plural(count, {
      one: `Inbox, ${formatCount(count)} request needs you`,
      other: `Inbox, ${formatCount(count)} requests need you`,
    }),
  count: ({ count }: { count: number }) => formatCount(count),
  notice: {
    title: ({ name }: { name: string }) => `${name} asks permission`,
    body: ({ what, exact }: { what: string; exact: string }) => (exact === what ? what : `${what}: ${exact}`),
  },
} as const;
