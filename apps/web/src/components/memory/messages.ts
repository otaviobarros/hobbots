import type { MemoryKind } from "@hobbots/domain";
import { formatCount, formatTime, plural } from "../../lib/format.ts";

const pages = (count: number) => `${formatCount(count)} ${plural(count, { one: "page", other: "pages" })}`;

/** User-facing copy for the Memory page (STD-I18N-001). */
export const messages = {
  title: "Memory",
  /** The line under the title. */
  head: {
    loading: ({ hobs }: { hobs: number }) => `${formatCount(hobs)} ${plural(hobs, { one: "hob", other: "hobs" })}`,
    empty: ({ hobs }: { hobs: number }) =>
      `${formatCount(hobs)} ${plural(hobs, { one: "hob", other: "hobs" })} · nothing remembered yet`,
    full: ({ hobs, count, shared }: { hobs: number; count: number; shared: number }) =>
      `${formatCount(hobs)} ${plural(hobs, { one: "hob", other: "hobs" })} · ${pages(count)} · ${formatCount(shared)} shared ${plural(shared, { one: "place", other: "places" })}`,
    offline: "Not answering · trying again every 30 seconds",
  },
  search: {
    label: "Search memory",
    placeholder: "Search everything hobs remember",
    clear: "Clear the search",
  },
  nav: {
    label: "Memory scopes",
    overview: "Overview",
    changes: "What changed",
    newChanges: ({ count }: { count: number }) => `${formatCount(count)} new`,
    shared: "Shared",
    about: "About you",
    aboutHint: "Every hob reads this",
    hobs: "Hobs",
    /** A hob scope whose hob is no longer listed, as after it was retired. */
    formerHob: "A retired hob",
  },
  offline: {
    title: "Memory is not answering",
    body: "Hobs keep working, but they cannot look things up. What they learn waits on the hub and is saved when memory is back.",
    asOf: ({ at }: { at: string }) => `Showing pages as of ${formatTime(at)}.`,
    retry: "Try again",
    retrying: "Trying…",
    details: "Details",
  },
  kinds: {
    rule: { one: "Rule", group: "Rules", hint: ({ who }: { who: string }) => `${who} always follows these` },
    howto: { one: "How-to", group: "How-tos", hint: ({ who }: { who: string }) => `Steps ${who} learned by doing` },
    gotcha: { one: "Gotcha", group: "Gotchas", hint: () => "Mistakes not to repeat" },
    decision: { one: "Decision", group: "Decisions", hint: () => "What was decided and why" },
    fact: { one: "Fact", group: "Facts", hint: () => "" },
    chat: { one: "Chat", group: "Recent chats", hint: ({ who }: { who: string }) => `Fade unless ${who} uses them` },
    note: { one: "Note", group: "Other pages", hint: () => "" },
  } satisfies Record<
    MemoryKind,
    { readonly one: string; readonly group: string; readonly hint: (who: { who: string }) => string }
  >,
  kindsLabel: "Kinds",
  all: "All",
  pinned: "Pinned",
  overview: {
    recent: "Recently learned",
    learned: ({ who }: { who: string }) => `${who} learned`,
    nothingRecent: "Nothing new this week.",
    about: "About you",
    open: "Open",
    aboutHint: "Every hob reads these before each chat.",
    aboutEmpty: "Nothing yet. Pages here are the rules every hob follows.",
    loading: "Opening memory…",
  },
  empty: {
    title: "Nothing remembered yet",
    body: "Your hobs start remembering from their first chat. When one learns how something is done, a mistake to avoid or a decision you made, it keeps a short page here. You can read, change or delete every page.",
    steps: [
      {
        title: "A hob learns",
        body: "While it works, a hob saves how-tos, mistakes and decisions to its own memory.",
      },
      {
        title: "It asks to share",
        body: "When something would help other hobs, it asks you before adding it to a project or to About you.",
      },
      {
        title: "Memory stays tidy",
        body: "Notes nobody uses fade after 30 days. Pinned pages never change on their own.",
      },
    ],
    footnote: "Memory stays on this computer, as plain text files.",
  },
  where: {
    hob: ({ name }: { name: string }) => `In ${name}'s memory`,
    project: ({ name }: { name: string }) => `In the ${name} project`,
    about: "In About you",
  },
  scope: {
    hobTitle: ({ name }: { name: string }) => `What ${name} remembers`,
    hobLine: ({ count }: { count: number }) => pages(count),
    openHob: ({ name }: { name: string }) => `Open ${name}'s page`,
    hobFooter: ({ name }: { name: string }) =>
      `Recent chats fade after 30 days unless ${name} uses them. Pinned pages never change on their own.`,
    projectLine: ({ identity, count }: { identity: string; count: number }) =>
      `What hobs know about ${identity} · ${pages(count)}`,
    projectReaders: "Who reads it",
    projectReadersBody:
      "Any hob working in this project. It finds these pages when it searches, and the pinned ones before each chat.",
    aboutTitle: "About you",
    aboutLine: "Every hob reads these before each chat.",
    nothing: "Nothing here yet.",
    nothingOfKind: "No page of this kind.",
    loadFailed: "Hobbots could not read these pages.",
    pageCount: ({ count }: { count: number }) => pages(count),
  },
  page: {
    breadcrumb: "Breadcrumb",
    learned: ({ who, when }: { who: string; when: string }) => `Learned by ${who} · updated ${when}`,
    written: ({ when }: { when: string }) => `Written by you · updated ${when}`,
    unknownAuthor: ({ when }: { when: string }) => `Updated ${when}`,
    aside: "About this page",
    origin: "Where it came from",
    hob: "Hob",
    you: "You",
    keptIn: "Kept in",
    keptInHob: ({ name }: { name: string }) => `${name}'s memory only`,
    keptInProject: ({ name }: { name: string }) => `The ${name} project`,
    keptInAbout: "About you, read by every hob",
    history: "History",
    learnedThis: ({ who }: { who: string }) => `${who} learned this`,
    changedThis: ({ who }: { who: string }) => `${who} changed this`,
    wroteThis: "You wrote this",
    youChanged: "You changed this",
    someone: "Someone",
    showChanges: "Show changes",
    hideChanges: "Hide changes",
    changesIn: ({ when }: { when: string }) => `What changed on ${when}`,
    firstVersion: "The first version of this page.",
    diffLoading: "Reading this version…",
    diffFailed: "Hobbots could not read this version.",
    diffCut: "This change is too long to show in full.",
    gone: "This page is not in memory any more.",
    goneHint: "It may have been deleted, or it faded.",
    loadFailed: "Hobbots could not read this page.",
    added: "Added",
    removed: "Removed",
  },
  results: {
    head: ({ count, q }: { count: number; q: string }) =>
      count === 0
        ? `Nothing for “${q}”`
        : `${formatCount(count)} ${plural(count, { one: "page mentions", other: "pages mention" })} “${q}”`,
    sub: ({ projects, hobs }: { projects: number; hobs: number }) =>
      `Across About you, ${formatCount(projects)} ${plural(projects, { one: "project", other: "projects" })} and ${formatCount(hobs)} ${plural(hobs, { one: "hob", other: "hobs" })}`,
    where: "Where to look",
    everywhere: "Everywhere",
    none: "No page mentions that here",
    noneHint: "Try Everywhere, or fewer words.",
    footnote: "You see every hob's memory. A hob only finds its own pages, About you and the projects it works in.",
    loadFailed: "Hobbots could not search memory.",
    searching: "Searching memory…",
  },
  changes: {
    title: "What changed",
    intro: "Every page hobs saved, and every change you made, newest first.",
    show: "Show",
    filters: { all: "Everything", hobs: "Saved by hobs", you: "Yours" },
    today: "Today",
    yesterday: "Yesterday",
    savedBy: ({ who }: { who: string }) => `Saved by ${who}`,
    savedByYou: "You changed it",
    saved: ({ who, kind, title }: { who: string; kind: string; title: string }) =>
      `${who} saved a ${kind.toLowerCase()}: ${title}`,
    youSaved: ({ title }: { title: string }) => `You saved ${title}`,
    open: "Open",
    nothing: "Nothing changed this week.",
    nothingHere: "Nothing of this kind changed this week.",
    loadFailed: "Hobbots could not read what changed.",
    every: "Hobbots asks memory what changed about once a minute.",
  },
  retry: "Try again",
};
