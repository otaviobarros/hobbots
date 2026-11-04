import { INBOX_HISTORY } from "@hobbots/domain";
import { formatCount, formatIn, formatList, plural } from "../../lib/format.ts";

/** User-facing copy for the Inbox page and the Needs you counts (STD-I18N-001). */
export const messages = {
  title: "Inbox",
  intro: "Who is waiting on whom",
  tabsLabel: "Inbox filters",
  tabs: { needs: "Needs you", history: "History" },
  listLabel: "Requests",
  waiting: ({ count }: { count: number }) => `${formatCount(count)} waiting on you`,
  from: ({ name }: { name: string }) => `${name} → you`,
  group: ({ name, thread }: { name: string; thread: string }) => `${name} · ${thread}`,
  hubGroup: "This hub · Devices",
  hub: "This hub",
  questName: ({ name }: { name: string }) => `${name}'s quest`,
  whenIn: ({ when, place }: { when: string; place: string }) => `${when} · ${place}`,
  view: { label: "Show", quest: "By quest", urgency: "By urgency" },
  questGroup: ({ name, goal }: { name: string; goal: string }) => `${name}'s quest · ${goal}`,
  untitledThread: "A thread",
  unknownHob: "A hob",
  unknownDevice: "a device",
  kind: { approval: "Approval", expired: "Expired", question: "Question", stuck: "Stuck", device: "New device" },
  /** One row of the list: who asked, as a chain, and when. */
  row: {
    arrow: " → ",
    you: "You",
    youEnd: "you",
    waitingOn: ({ name }: { name: string }) => `${name} is waiting on this`,
    stuckAfter: ({ count }: { count: number }) =>
      plural(count, { one: `Stuck after ${formatCount(count)} try`, other: `Stuck after ${formatCount(count)} tries` }),
    retired: ({ name }: { name: string }) => `${name} retired`,
    deviceAsks: "A new device asks to join",
  },
  status: {
    pending: ({ expiry }: { expiry: string }) => `Waiting on you · ${expiry}`,
    pendingNoExpiry: "Waiting on you",
    approved: "You allowed this",
    approvedAlways: "You allowed this always",
    approvedForTask: "You allowed this for its task",
    denied: "You denied this",
    expired: "Expired · nothing ran",
  },
  expiry: {
    soon: "expires in under a minute",
    minutes: ({ count }: { count: number }) => `expires ${formatIn(count, "minute")}`,
    hours: ({ count }: { count: number }) => `expires ${formatIn(count, "hour")}`,
  },
  allClear: "Nothing needs you",
  allClearHint: "Your hobs are working. Approvals, questions and stuck work land here first, and on Home.",
  seeDecided: "See what you decided",
  backHome: "Back to Home",
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
    quest: "Quest",
    thread: "Thread",
    task: "Task",
    work: "Work",
    tries: "Tries",
    askedBy: "Asked by",
    passedUpBy: "Passed up by",
    asked: "Asked",
    expires: "Expires",
    expiresLead: ({ expiry, name }: { expiry: string; name: string }) =>
      `It ${expiry}. After that ${name} has to ask again.`,
    decided: "Decided",
    openChat: "Open in the chat",
    deviceWhy: ({ name }: { name: string }) =>
      `Someone opened Hobbots on ${name}, a device this hub does not know. Allow it only if it shows the same code.`,
    deviceFoot: "Deny turns that device away. Decide later keeps it waiting in Settings › Devices.",
    expiredFoot: "Expired requests can never be approved late. The hob asks again with what is true now.",
    pendingFoot: ({ name }: { name: string }) =>
      `${name} can only do what is listed here. Anything else asks again. Deciding here works the same as in the chat.`,
  },
  history: {
    heading: "Decision history",
    title: "What you decided",
    intro: `Your latest ${formatCount(INBOX_HISTORY)} decisions, most recent first, with who asked and what it was for.`,
    verdict: { once: "Once", always: "Always", task: "Task", denied: "Denied", expired: "Expired" },
    expiredNote: "Expired requests never run. The hob asks again with what is true now.",
    meta: ({ when, thread }: { when: string; thread: string }) => `${when} · ${thread}`,
    action: ({ name, action }: { name: string; action: string }) => `${name}: ${action}`,
    /**
     * Who decided a request and where (#598), one whole sentence per decision and surface; `unknown`
     * when the client did not say where.
     */
    decider: {
      once: {
        chat: ({ device }: { device: string }) => `Allowed once from ${device} in the chat`,
        inbox: ({ device }: { device: string }) => `Allowed once from ${device} in the Inbox`,
        unknown: ({ device }: { device: string }) => `Allowed once from ${device}`,
      },
      always: {
        chat: ({ device }: { device: string }) => `Allowed always from ${device} in the chat`,
        inbox: ({ device }: { device: string }) => `Allowed always from ${device} in the Inbox`,
        unknown: ({ device }: { device: string }) => `Allowed always from ${device}`,
      },
      task: {
        chat: ({ device }: { device: string }) => `Allowed for its task from ${device} in the chat`,
        inbox: ({ device }: { device: string }) => `Allowed for its task from ${device} in the Inbox`,
        unknown: ({ device }: { device: string }) => `Allowed for its task from ${device}`,
      },
      denied: {
        chat: ({ device }: { device: string }) => `Denied from ${device} in the chat`,
        inbox: ({ device }: { device: string }) => `Denied from ${device} in the Inbox`,
        unknown: ({ device }: { device: string }) => `Denied from ${device}`,
      },
    },
    expiredUndecided: "Expired before anyone decided",
  },
  /** A question no lead could answer, in Needs you. */
  question: {
    label: ({ name }: { name: string }) => `Question from ${name}`,
    title: ({ name }: { name: string }) => `${name} asks you`,
    direct: "No lead could answer it, so it comes to you. Your answer goes straight back.",
    passedBy: ({ names }: { names: ReadonlyArray<string> }) => `Passed up to you by ${formatList(names)}.`,
    openChat: ({ name }: { name: string }) => `Open ${name}'s chat`,
    loading: "Reading the questions for you…",
    loadFailed: "Hobbots could not read the questions for you.",
  },
  sidebar: ({ count }: { count: number }) => `Inbox, ${formatCount(count)} waiting on you`,
  count: ({ count }: { count: number }) => formatCount(count),
} as const;
