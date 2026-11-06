import { memoryBriefDigest } from "@hobbots/agents";
import type { TaskBriefMark, TaskId } from "@hobbots/domain";

/**
 * A lead's briefing as parts (#1027): lines it is told on every turn, and lists and rules whose
 * entries a resumed session is told again only once they change. A lead's chat resumes the same
 * session, so it already holds what earlier turns told it.
 */

/** One entry of a list, by a key that names it across turns, such as the Task or question it shows. */
interface BriefEntry {
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
}

export type BriefPart =
  /** Told on every turn: the rules, and where the Task itself stands. */
  | { readonly _tag: "Fixed"; readonly lines: ReadonlyArray<string> }
  /** A list under its heading: a resumed session is told the entries new or changed since it was last briefed. */
  | {
      readonly _tag: "Listed";
      readonly group: string;
      readonly heading: ReadonlyArray<string>;
      readonly entries: ReadonlyArray<BriefEntry>;
    };

export const fixed = (...lines: ReadonlyArray<string>): BriefPart => ({ _tag: "Fixed", lines });

/**
 * A rule the session keeps once told (#1039), under `key`: told again only once its text changes,
 * or once it stops applying and applies again. No lines, no rule.
 */
export const rule = (key: string, ...lines: ReadonlyArray<string>): BriefPart => ({
  _tag: "Listed",
  group: "rule",
  heading: [],
  entries: lines.length === 0 ? [] : [{ key, lines }],
});

/** What a resumed session is told first, so it reads the rest as changes. */
export const SINCE_LAST_TURN =
  "Only what changed since your last turn is listed below; everything else, your rules included, stands as you were last told. read_tasks shows it all.";

/** What a briefing tells its session, and what the session will then have been told. */
export interface Briefed {
  readonly text: string;
  readonly told: TaskBriefMark;
}

const markKey = (group: string, key: string) => `${group}:${key}`;

/**
 * The briefing `parts` make on `taskId`: whole when `told` is null or marks another Task, else only
 * what changed since `told`. Fixed lines are always told. The mark it returns covers every entry,
 * shown or not, so the next turn compares with all the session holds.
 */
export const renderBrief = (taskId: TaskId, parts: ReadonlyArray<BriefPart>, told: TaskBriefMark | null): Briefed => {
  const since = told !== null && told.taskId === taskId ? told.entries : null;
  const entries: Record<string, string> = {};
  const lines = parts.flatMap((part): ReadonlyArray<string> => {
    if (part._tag === "Fixed") return part.lines;
    const changed = part.entries.filter((entry) => {
      const key = markKey(part.group, entry.key);
      const digest = memoryBriefDigest(entry.lines.join("\n"));
      entries[key] = digest;
      return since?.[key] !== digest;
    });
    return changed.length === 0 ? [] : [...part.heading, ...changed.flatMap((entry) => entry.lines)];
  });
  const [first = "", ...rest] = lines;
  return {
    text: (since === null ? lines : [first, SINCE_LAST_TURN, ...rest]).join("\n"),
    told: { taskId, entries },
  };
};
