import { formatCount, formatList, plural } from "../../lib/format.ts";

const hobs = (count: number) =>
  plural(count, { one: `${formatCount(count)} new hob`, other: `${formatCount(count)} new hobs` });
const targets = (count: number) =>
  plural(count, { one: `${formatCount(count)} hob`, other: `${formatCount(count)} hobs` });

/** User-facing copy for a hob proposal card, in the Inbox and in the chat (ADR 034, STD-I18N-001). */
export const messages = {
  what: {
    summon: ({ who, count }: { who: string; count: number }) => `${who} proposes ${hobs(count)}`,
    change: ({ who, count }: { who: string; count: number }) => `${who} proposes changes to ${targets(count)}`,
    self: ({ who }: { who: string }) => `${who} proposes changes to itself`,
    pause: ({ who, hob }: { who: string; hob: string }) => `${who} proposes pausing ${hob}`,
    wake: ({ who, hob }: { who: string; hob: string }) => `${who} proposes waking ${hob}`,
    retire: ({ who, hob }: { who: string; hob: string }) => `${who} proposes retiring ${hob}`,
    unknown: "A hob",
  },
  kind: "Hobs",
  label: ({ who }: { who: string }) => `Proposal from ${who}`,
  cardLabel: ({ what }: { what: string }) => what,
  why: "Nothing is made or changed until you allow it. What you allow is made by you, on the manager's proposal.",
  safety: ({ reason }: { reason: string }) => `Why this asks you: ${reason}`,
  rows: "Hobs",
  allow: "Allow",
  deny: "Deny",
  edit: "Edit in Summon",
  allowAll: "Allow all",
  denyAll: "Deny all",
  /** "Always allow summoning new hobs". */
  alwaysAllow: ({ words }: { words: string }) => `Always allow ${words}`,
  alwaysHint: ({ who }: { who: string }) =>
    `Sets that answer to Allow on ${who}'s Summoning Charm, as a change made by you. It shows in ${who}'s History.`,
  alwaysSet: ({ who, words }: { who: string; words: ReadonlyArray<string> }) =>
    `You set ${formatList(words)} to Allow for ${who}, so calls like this no longer ask. It shows in ${who}'s History.`,
  history: "See History",
  editedNote: "Your version",
  state: {
    pending: "Waiting for you",
    applying: "Being made",
    allowed: "Allowed",
    denied: "Denied",
    failed: "Could not be done",
  },
  changedSince: "This hob changed since the proposal was made, so it can only be denied.",
  fields: {
    role: "Role",
    sigil: "Sigil",
    goodAt: "Good at",
    brain: "Brain",
    effort: "Effort",
    folders: "Folders",
    hidden: "Hidden shared folders",
    charms: "Charms",
    answers: "Answers",
    look: "Look",
    voice: "Voice",
    length: "Reply length",
    name: "Name",
    hat: "Hat",
    tool: "Tool",
    instructions: "Instructions",
  },
  noValue: "None",
  defaultModel: "default model",
  defaultEffort: "default effort",
  yourAnswers: "The manager's own",
  instructions: "Instructions",
  noInstructions: "No instructions: Summon's defaults.",
  before: "Before",
  after: "After",
  /** "Read GitHub: Never". */
  answer: ({ operation, answer }: { operation: string; answer: string }) => `${operation}: ${answer}`,
  answers: { allow: "Allow", ask: "Ask", deny: "Never" },
  notSet: "not set",
  retire: {
    owns: ({ hob }: { hob: string }) =>
      `${hob}'s chats, memory and History stay, read-only. Hobs it summoned stay too, and only you can manage them.`,
    finish: "Its running replies finish first.",
    stop: "Its running replies stop now.",
    confirm: ({ hob }: { hob: string }) => `I understand ${hob} is retired and this cannot be undone`,
    highRisk: "Retiring a hob is high risk",
  },
  pause: ({ hob }: { hob: string }) => `${hob} stops taking new work until you or a manager wakes it.`,
  wake: ({ hob }: { hob: string }) => `${hob} takes new work again.`,
  created: "Created",
  createdOpen: ({ name }: { name: string }) => `Open ${name}`,
  settled: ({ who }: { who: string }) => `Decided. ${who} heard what was made and what was denied.`,
  failed: "Hobbots could not save that decision. Try again.",
  closed: "This was decided elsewhere.",
  changed: "This hob changed since the proposal was made. Deny it, or let the manager propose again.",
  notConfirmed: "Tick the check box first: retiring a hob cannot be undone.",
  refused: ({ message }: { message: string }) => `It cannot be made like that: ${message}`,
  loading: "Reading the proposal…",
  loadFailed: "Hobbots could not read this proposal.",
  editing: {
    heading: ({ who }: { who: string }) => `Your version of ${who}'s proposal`,
    allow: ({ name }: { name: string }) => `Allow ${name} as edited`,
    allowing: ({ name }: { name: string }) => `Allowing ${name}…`,
    missing: "This proposal row is gone or was decided already.",
    backToInbox: "Back to the Inbox",
  },
} as const;
