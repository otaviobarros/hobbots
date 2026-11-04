import { formatCount, formatDay, plural } from "../../lib/format.ts";

/** User-facing copy for a hob's page (STD-I18N-001). */
export const messages = {
  /** The hero's role and stats line, such as "Writer · 3 chats". */
  roleStats: ({ role, stats }: { role: string; stats: string }) => `${role} · ${stats}`,
  page: ({ name }: { name: string }) => `${name}'s page`,
  crumbs: "Breadcrumb",
  yourHobs: "Your hobs",
  loading: "Loading this hob…",
  missing: "This hob is not here. It may have been retired.",
  tags: {
    needsYou: "Needs you",
    working: "Working",
    resting: "Resting",
    paused: "Paused",
    failed: "Had a problem",
    new: "New",
  },
  stats: {
    chats: ({ count }: { count: number }) =>
      count === 0 ? "No chats yet" : plural(count, { one: "1 chat", other: `${formatCount(count)} chats` }),
    since: ({ date }: { date: string }) => `with you since ${formatDay(date)}`,
    line: ({ chats, since }: { chats: string; since: string }) => `${chats} · ${since}`,
  },
  doing: {
    writing: ({ title }: { title: string }) => `Writing “${title}”`,
    thinking: ({ title }: { title: string }) => `Thinking about “${title}”`,
    waiting: "Waiting on you",
    seeWhat: "See what it needs",
    paused: "Paused until you wake it",
    live: "Working",
  },
  newChat: "New chat",
  newChatWith: ({ name }: { name: string }) => `New chat with ${name}`,
  profile: "Profile",
  tabs: {
    label: ({ name }: { name: string }) => `${name}'s chats and history`,
    chats: "Chats",
    history: "History",
  },
  chats: {
    open: ({ title }: { title: string }) => `Open ${title}`,
    working: "Working",
    pinned: "Pinned",
    quest: ({ goal, done, total }: { goal: string; done: number; total: number }) =>
      `${goal} · ${formatCount(done)} of ${formatCount(total)}`,
    groups: { pinned: "Pinned", today: "Today", week: "Earlier this week", older: "Older", matches: "Matches" },
    search: {
      label: ({ name }: { name: string }) => `Search ${name}'s chats`,
      placeholder: "Search chats and messages",
      clear: "Clear the search",
      searching: "Searching…",
      failed: "The search did not answer. Try again.",
      none: ({ name, query }: { name: string; query: string }) => `No chats with ${name} mention “${query}”.`,
      archivedHint: "Archived chats are searched in the Archive.",
      clearButton: "Clear search",
    },
    needs: ({ count }: { count: number }) => (count === 1 ? "1 needs you" : `${formatCount(count)} need you`),
    showOlder: ({ count }: { count: number }) =>
      plural(count, { one: "Show 1 older chat", other: `Show ${formatCount(count)} older chats` }),
    archived: ({ count }: { count: number }) => `Archived chats · ${formatCount(count)}`,
    menu: ({ title }: { title: string }) => `More for “${title}”`,
    rename: "Rename",
    renameLabel: ({ title }: { title: string }) => `New title for “${title}”`,
    pin: "Pin to the top",
    unpin: "Unpin",
  },
  newHob: {
    label: "No chats yet",
    hello: ({ name, note }: { name: string; note: string | null }) =>
      note === null ? `Hi! I'm ${name}. Where shall we start?` : `Hi! I'm ${name}. ${note} Where shall we start?`,
    tryOne: "Try one of these",
    start: ({ prompt }: { prompt: string }) => `Start a chat: ${prompt}`,
    /** Three first asks for each everyday helper, then for each family of roles. */
    starters: {
      assistant: ["Help me plan my week", "Summarize an article I paste", "Explain a concept simply"],
      researcher: [
        "Find three good sources on a topic I name",
        "Compare two products for me, with links",
        "Sum up what is known about a question I have",
      ],
      writer: [
        "Turn my bullet points into a friendly email",
        "Tighten this blog post and keep my voice",
        "Write three subject lines for an email I paste",
      ],
      editor: [
        "Fix the mistakes in a text I paste",
        "Make this paragraph shorter and clearer",
        "Tell me what reads badly in my draft",
      ],
      translator: [
        "Translate a message I paste and keep its tone",
        "Check my translation for phrases that do not carry over",
        "Say this politely in another language",
      ],
      notetaker: [
        "Turn my meeting notes into decisions and to-dos",
        "Sum up a transcript I paste in five lines",
        "Make a follow-up email from my notes",
      ],
      brainstormer: [
        "Give me five ideas for a name I need",
        "Help me get unstuck on a problem I describe",
        "Suggest three different directions for my project",
      ],
      organizer: [
        "Plan how to sort a messy folder before moving anything",
        "Suggest clear names for a set of files",
        "Make a checklist for a job I describe",
      ],
      leadership: [
        "Help me pick what matters most this week",
        "Push back on a plan I paste",
        "Draft a short update for my team",
      ],
      software: [
        "Explain how a part of my project works",
        "Find the cause of a bug I describe",
        "Plan a small change before you make it",
      ],
      business: [
        "Make sense of a spreadsheet I share",
        "Draft a reply to a customer email I paste",
        "List what is late and who should unblock it",
      ],
      learning: [
        "Explain a topic as if I were new to it",
        "Quiz me on something I am learning",
        "Make a short study plan for this month",
      ],
      creative: [
        "Give me three ideas for my next piece",
        "Give feedback on a draft I paste",
        "Help me plan a project from idea to done",
      ],
      life: [
        "Help me plan a week of meals",
        "Make a checklist for a trip",
        "Help me set a goal and the first small step",
      ],
    },
  },
  history: {
    filters: {
      label: "Show",
      all: "Everything",
      work: "Work",
      you: "Your decisions",
      quest: "Quests",
    },
    noteLead: "Includes the work of the hobs on its quests",
    note: ({ name }: { name: string }) => `Across all of ${name}'s chats`,
    loading: "Reading the history…",
    failed: "The history did not load. Try again.",
    retry: "Try again",
    today: "Today",
    yesterday: "Yesterday",
    you: "You",
    someone: "A retired hob",
    waiting: "Waiting on you",
    review: "Review",
    workbench: "Workbench",
    chat: "Chat",
    showEarlier: ({ count }: { count: number }) =>
      plural(count, { one: "Show 1 earlier day", other: `Show ${formatCount(count)} earlier days` }),
    loadingEarlier: "Reading earlier days…",
    empty: "Nothing yet.",
    emptyBody: ({ name }: { name: string }) =>
      `When ${name} starts working, what it does, and what you decide, shows up here.`,
    emptyKind: "Nothing of this kind yet.",
    emptyKindBody: ({ name }: { name: string }) => `Try Everything to see all of ${name}'s work.`,
    asked: ({ brief }: { brief: string }) => `You asked for “${brief}”`,
    pickedUp: ({ brief, lead }: { brief: string; lead: string }) => `Picked up “${brief}” from ${lead}`,
    finished: ({ brief }: { brief: string }) => `Finished “${brief}”`,
    stopped: ({ brief, tries }: { brief: string; tries: number }) =>
      tries > 1 ? `Stopped “${brief}” after ${formatCount(tries)} tries` : `Stopped “${brief}”`,
    cancelled: ({ brief }: { brief: string }) => `“${brief}” was cancelled`,
    questStarted: ({ goal, party }: { goal: string; party: string | null }) =>
      party === null ? `Started ${goal}` : `Started ${goal} with ${party}`,
    questDone: ({ goal }: { goal: string }) => `${goal} finished`,
    questEnded: ({ goal }: { goal: string }) => `${goal} ended before it was done`,
    approval: {
      asks: ({ label }: { label: string }) => `Asks you before “${label}”`,
      allowed: ({ label, always }: { label: string; always: boolean }) =>
        always ? `You allowed “${label}”, always` : `You allowed “${label}”`,
      denied: ({ label }: { label: string }) => `You denied “${label}”`,
      expired: ({ label }: { label: string }) => `Nobody answered “${label}” in time`,
    },
    question: {
      asks: ({ text }: { text: string }) => `Asks you: ${text}`,
      answered: ({ answer }: { answer: string }) => `You answered: ${answer}`,
    },
  },
  aside: {
    label: ({ name }: { name: string }) => `About ${name}`,
    showFewer: "Show fewer",
    quests: {
      label: "Quests it leads",
      showAll: ({ count }: { count: number }) => `Show all ${formatCount(count)}`,
      progress: ({ done, total, needs }: { done: number; total: number; needs: number }) =>
        `${formatCount(done)} of ${formatCount(total)} done${needs > 0 ? ` · ${formatCount(needs)} need you` : ""}`,
      finished: ({ count }: { count: number }) =>
        plural(count, { one: "1 finished quest", other: `${formatCount(count)} finished quests` }),
    },
    backpack: {
      label: "Backpack",
      intro: "What it still has to deal with. You can look; it does the work.",
      empty: "Empty. Nothing waiting on anyone.",
      list: ({ name }: { name: string }) => `What ${name} still has to deal with`,
    },
    setup: "Setup",
    worksIn: "Works in",
    noFolders: "No folders yet.",
    moreFolders: ({ count }: { count: number }) => `${formatCount(count)} more`,
    thinksWith: "Thinks with",
    change: "Change in Profile",
  },
} as const;
