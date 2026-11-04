import { formatCount, formatList, plural } from "../../lib/format.ts";

/** Copy for the Quest room's lanes (STD-I18N-001). */
export const messages = {
  region: "The party's lanes",
  lane: ({ name }: { name: string }) => `${name}'s lane`,
  party: ({ name }: { name: string }) => `${name}'s party`,
  show: ({ name }: { name: string }) => `Show ${name}'s work in the Workbench`,
  lineup: "The party",
  jump: ({ name, state }: { name: string; state: string }) => `Go to ${name}'s lane, ${state}`,
  jumpTitle: ({ name, state }: { name: string; state: string }) => `${name} · ${state}`,
  did: ({ name }: { name: string }) => `What ${name} did`,
  role: {
    lead: "Lead",
    leads: ({ names }: { names: string }) => `Leads ${names}`,
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
  folded: ({ count }: { count: number }) =>
    plural(count, { one: "Show 1 earlier step", other: `Show ${formatCount(count)} earlier steps` }),
  handOut: ({ label, name }: { label: string; name: string }) => `${label} → ${name}`,
  handIn: ({ label, name }: { label: string; name: string }) => `← ${label} from ${name}`,
  briefed: ({ names }: { names: string }) => `Briefed ${names}`,
  waits: ({ names }: { names: string }) => `Waits on ${names}`,
  now: "Working",
  result: {
    completed: "Result",
    failed: "Stopped",
    cancelled: "Cancelled",
  },
  stoppedWhy: "It stopped before it finished.",
};
