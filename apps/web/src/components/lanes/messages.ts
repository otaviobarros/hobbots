import { formatCount, formatList, plural } from "../../lib/format.ts";

/** Copy for the Quest room's lanes (STD-I18N-001). */
export const messages = {
  region: "Lanes",
  lane: ({ name }: { name: string }) => `${name}'s lane`,
  party: ({ name }: { name: string }) => `${name}'s party`,
  show: ({ name }: { name: string }) => `Show ${name}'s work in the Workbench`,
  /**
   * What a screen reader hears between the parts of a lane's header, which the eye gets from the
   * layout, and what the header does after them.
   */
  said: {
    role: ", ",
    title: ": ",
    state: ", ",
    show: ({ name }: { name: string }) => `. Show ${name}'s work in the Workbench`,
  },
  lineup: "The party",
  jump: ({ name, state }: { name: string; state: string }) => `Go to ${name}'s lane, ${state}`,
  jumpTitle: ({ name, state }: { name: string; state: string }) => `${name} · ${state}`,
  did: ({ name }: { name: string }) => `What ${name} did`,
  role: {
    lead: "Lead",
    leads: ({ names }: { names: string }) => `Leads ${names}`,
    /** A member that started a Quest of its own and brought nobody in yet. */
    leadsQuest: "Leads a quest",
  },
  names: (names: ReadonlyArray<string>) => formatList(names),
  you: "you",
  /** What each mark stands for, for a screen reader; the glyph beside it is decorative. */
  mark: {
    read: "Read",
    edit: "Edited",
    delete: "Deleted",
    run: "Ran",
    refused: "Refused",
  },
  /**
   * Why the hub refused a hob's Task tool call, by its reason, as a lane shows it beside the tool's
   * label. Most are the hub keeping order, such as a Task that tried to finish too soon, and the hob
   * goes on after them. A reason missing here shows the label alone.
   */
  refusal: {
    "children-open": "work under it was still open",
    "dependencies-open": "a Task it depends on was not done yet",
    "questions-open": "a question was still waiting",
    "milestones-open": "a milestone was not reached yet",
    "approvals-pending": "a request was waiting for you",
    "items-open": "something in its backpack was unread",
    "milestone-mismatch": "no planned milestone matched",
    "checkpoint-kind": "that kind of report does not fit here",
    "task-ended": "the Task had already ended",
    "outside-subtree": "that Task is not under this one",
    "authority-wider": "it asked for more than this hob may do",
    "depth-limit": "the party is as deep as it may go",
    "concurrency-limit": "too much is running at once",
    "invalid-input": "the call was not filled in right",
  },
  added: ({ count }: { count: number }) => `+${formatCount(count)}`,
  addedLabel: ({ count }: { count: number }) =>
    plural(count, { one: "1 line added", other: `${formatCount(count)} lines added` }),
  newFile: "new",
  deleted: "deleted",
  succeeded: "✓",
  succeededLabel: "succeeded",
  exit: ({ code }: { code: number }) => `exit ${code}`,
  failed: "failed",
  running: "running",
  uncertain: "unknown",
  stopped: "stopped by you",
  /** Older marks folded into one count, as the design draws it; the label says what opening it does. */
  folded: ({ count }: { count: number }) => `+${formatCount(count)} more`,
  foldedLabel: ({ count }: { count: number }) =>
    plural(count, { one: "Show 1 earlier step", other: `Show ${formatCount(count)} earlier steps` }),
  /** A finished Quest's lane folds to its results; this opens the rest. */
  showSteps: ({ count }: { count: number }) =>
    plural(count, { one: "Show the 1 step", other: `Show the ${formatCount(count)} steps` }),
  handOut: ({ label, name }: { label: string; name: string }) => `${label} → ${name}`,
  handIn: ({ label, name }: { label: string; name: string }) => `← ${label} from ${name}`,
  briefed: ({ names }: { names: string }) => `Briefed ${names}`,
  waits: ({ names }: { names: string }) => `Waits on ${names}`,
  now: "Working",
  /** A turn with no step running and a command it left running: the command it waits on, exact. */
  waitsOnCommand: ({ command }: { command: string }) => `Waiting on ${command}`,
  /** How long ago the room last recorded anything the hob did, once a running lane has gone quiet. */
  quiet: ({ ago }: { ago: string }) => `last step ${ago}`,
  result: {
    completed: "Result",
    failed: "Stopped",
    cancelled: "Cancelled",
  },
  stoppedWhy: "It stopped before it finished.",
  /** A lane whose Workbench records could not all be read shows what it has and says so. */
  unread: ({ name }: { name: string }) => `Some of what ${name} did could not be read.`,
  tryAgain: "Try again",
};
