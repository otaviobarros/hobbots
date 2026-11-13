import { formatCount, plural } from "../../lib/format.ts";

interface Named {
  readonly name: string;
}

/** Copy for a quest in its chat's or camp's sheet, and its Workbench beside the chat (ADR 037, STD-I18N-001). */
export const messages = {
  questEyebrow: ({ name }: Named) => `${name}'s quest`,
  taskEyebrow: ({ name }: Named) => `${name}'s task`,
  notFound: "This work is not in this thread.",
  readFailed: "The quest could not be opened.",
  tryAgain: "Try again",
  showInWorkbench: "Show in the Workbench",
  details: "Everything in this task",
  /** A Task's line in the sheet: which try it is on and when it started. */
  taskMeta: ({ attempt, age }: { attempt: number; age: string }) =>
    attempt === 0 ? `not started · ${age}` : `attempt ${formatCount(attempt)} · ${age}`,
  /** The quest in the sheet (ADR 037). */
  sheet: {
    label: ({ title }: { title: string }) => `${title}, quest`,
    back: ({ title }: { title: string }) => `Back to ${title}`,
    close: "Close the quest",
    /** The sheet's title while the quest is read. */
    opening: "Opening the quest…",
    menu: ({ title }: { title: string }) => `${title} menu`,
    pin: "Pin quest",
    unpin: "Unpin quest",
    cancelQuest: "Cancel quest…",
    cancelTask: "Cancel task…",
    /** Under the title: how far it got and who leads it. */
    line: ({ done, total, name }: { done: number; total: number; name: string }) =>
      total === 0 ? `${name} leads` : `${formatCount(done)} of ${formatCount(total)} done · ${name} leads`,
    needYou: ({ count }: { count: number }) =>
      plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
    /** The quest's acceptance criteria and where each stands (#1445). */
    criteria: "Done when",
    optional: "optional",
    criterion: {
      open: "Not checked",
      accepted: "Accepted",
      "needs-rework": "Needs rework",
      waived: "Waived",
    },
    /** The artifact version a criterion was accepted on, and whether a newer one voided it. */
    evidence: ({ label, version }: { label: string; version: number }) => `${label}, version ${formatCount(version)}`,
    voided: "a newer version replaced it",
    /** Who last decided a criterion, and why. */
    decidedBy: ({ who, reason }: { who: string; reason: string }) => `${who}: ${reason}`,
    byYou: "You",
    byHub: "Hobbots",
    /** A lead asked you to waive a required criterion, and your answer decides it. */
    waiverAsked: "Waiting on your answer to waive it",
    showWork: "Show the work",
    showWorkHint: "Changes, files and terminals, in the Workbench beside the chat",
    team: "Who's on it",
    hobWork: ({ name }: Named) => `${name}'s work`,
    showHob: ({ name }: Named) => `Show ${name}'s work in the Workbench`,
    role: { lead: "leads", leads: "leads a party", member: "" },
    thread: "Thread",
    nothingYet: "Nothing said yet. The lead writes here when something lands or needs you.",
    /** The quest's thread could not read what was said in its chat; what the Tasks hold still shows. */
    threadUnread: "What was said in this quest could not be read.",
    you: "You",
    passedTo: ({ name }: Named) => `to ${name}`,
    delivered: "Delivered",
    failed: "Failed, waiting on its lead or you",
    compose: ({ name }: Named) => `Message ${name} about this quest`,
    composeHint: "It goes to the lead in this chat. The receipt shows whom it passes it to.",
    send: "Send",
    sending: "Sending…",
    sendFailed: "That didn't send. Hobbots may be reconnecting.",
  },
  /** A camp's quest pill (ADR 037), from the hub's quest summaries. */
  pill: {
    quests: ({ count }: { count: number }) => plural(count, { one: "1 quest", other: `${formatCount(count)} quests` }),
    review: ({ count }: { count: number }) => `${formatCount(count)} ready for review`,
    needYou: ({ count }: { count: number }) =>
      plural(count, { one: "1 needs you", other: `${formatCount(count)} need you` }),
    open: "Open the camp's quests",
    /** The pill's name: what it shows, then what it does. */
    named: ({ parts }: { parts: ReadonlyArray<string> }) => `${parts.join(", ")}. Open the camp's quests`,
  },
  /** The banner a finished request shows under the quest's title. */
  finished: {
    questTitle: "Quest finished",
    taskTitle: "Task finished",
    tasks: ({ done, total }: { done: number; total: number }) =>
      `${formatCount(done)} of ${formatCount(total)} ${total === 1 ? "task" : "tasks"} done`,
    took: ({ took }: { took: string }) => `took ${took}`,
    nothingNeedsYou: "nothing needs you",
    changes: "See what changed",
    files: "Open the files",
  },
  /** The banner a request shows once its lead stopped it at your request (#1346), never a finish. */
  stopped: {
    title: "Stopped at your request",
    stopping: "Stopping at your request",
    stoppingHint: "Hobbots is stopping the work under it.",
    reason: ({ reason }: { reason: string }) => `Why: ${reason}`,
  },
  /** The quest's Workbench beside the chat (ADR 023). */
  workbench: {
    label: "The quest's work",
    named: ({ title }: { title: string }) => `${title}, the quest's work`,
    back: "Back to the quest",
    close: "Close the quest",
    closeHint: "The chat takes the full width again",
  },
  chat: {
    fold: "Fold the chat",
    foldHint: "Fold the chat to give the Workbench more room",
    open: "Open the chat",
    folded: "Chat, folded",
    unread: ({ name }: Named) => `Open the chat, new from ${name}`,
    newFrom: ({ name }: Named) => `New from ${name}`,
  },
  dock: {
    label: "Workbench",
    /** The Workbench's name, which says whose work it shows: "Workbench for Draft the landing copy". */
    named: ({ title }: { title: string }) => `Workbench for ${title}`,
  },
} as const;
