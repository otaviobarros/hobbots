import type { RuntimeEvent } from "@hobbots/agents";
import type { HookEnd } from "./command-exit.ts";
import { ownFileText } from "./tool-output.ts";

/**
 * A Bash command Claude Code runs in the background (`run_in_background`, or a foreground one moved
 * there) returns its call at once: the PostToolUse hook gets a `backgroundTaskId` and no exit code,
 * while the command goes on (#1018). Its end arrives later as a `task_notification` system message
 * for that task, with its status, a summary and the file its output went to (the SDK's
 * `SDKTaskNotificationMessage`). So the call's `ToolFinished` waits for that notification, and a
 * command still running when the turn ends stays running for the hub to record as not known.
 */

/** What a `task_notification` message carries that says how a task ended. */
export interface TaskEnd {
  readonly task_id: string;
  readonly tool_use_id?: string;
  readonly status: "completed" | "failed" | "stopped";
  readonly output_file: string;
  readonly summary: string;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;

/** The background task a Bash call's hook says it went on as, or undefined when the call ended. */
const backgroundTaskOf = (end: HookEnd): string | undefined => {
  if (end.hook_event_name !== "PostToolUse" || end.tool_name !== "Bash") return undefined;
  const task = field(end.tool_response, "backgroundTaskId");
  return typeof task === "string" && task !== "" ? task : undefined;
};

/**
 * The exit code a task's summary states, or undefined. Claude Code ends it with ` completed (exit
 * code N)`, with a note from its own reading of the code inside the parentheses (grep's "No matches
 * found"), or ` failed with exit code N`. The command's description comes first and may hold the
 * same words, so only the last such ending counts, and only when nothing but the code and a note
 * without parentheses follows it.
 */
const summaryExit = (end: Pick<TaskEnd, "status" | "summary">): number | undefined => {
  const [marker, rest] =
    end.status === "completed"
      ? ['" completed (exit code ', /^(\d+)(: [^()]*)?\)$/]
      : end.status === "failed"
        ? ['" failed with exit code ', /^(\d+)$/]
        : [null, null];
  if (marker === null) return undefined;
  const summary = end.summary.trim();
  const at = summary.lastIndexOf(marker);
  const match = at === -1 ? null : rest.exec(summary.slice(at + marker.length));
  if (match === null) return undefined;
  const code = Number(match[1]);
  // A completed command whose code is not 0 is one Claude Code read as no error, as a foreground
  // call's `returnCodeInterpretation` says: the code alone would make it read as failed.
  return end.status === "completed" && code !== 0 ? undefined : code;
};

/**
 * The `ToolFinished` event for call `id` from how its background task ended. A task that did not
 * complete failed, a stopped one included: it never ran to its end.
 */
export const backgroundFinished = (
  id: string,
  end: Pick<TaskEnd, "status" | "summary">,
  output: string | undefined,
): RuntimeEvent => {
  const exitCode = summaryExit(end);
  return {
    _tag: "ToolFinished",
    id,
    failed: end.status !== "completed",
    ...(output === undefined || output === "" ? {} : { output }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
};

/** Whether a message from Claude Code is a task's end. */
export const isTaskEnd = (message: unknown): message is TaskEnd =>
  field(message, "type") === "system" &&
  field(message, "subtype") === "task_notification" &&
  typeof field(message, "task_id") === "string";

/**
 * The background commands of one turn: each call that went to the background is reported finished
 * when its task ends, with what the command printed. A task that ends before its call is known as
 * backgrounded waits for it, so the order the two arrive in does not matter.
 */
export const backgroundCommands = (
  report: (event: RuntimeEvent) => void,
  read: (path: string) => Promise<string | undefined> = ownFileText,
) => {
  // Each running background task's call.
  const running = new Map<string, string>();
  // Each task that ended before its call was known as backgrounded, by task and by call.
  const early = new Map<string, TaskEnd>();
  const finish = async (id: string, end: TaskEnd) => {
    const output = end.output_file === "" ? undefined : await read(end.output_file).catch(() => undefined);
    report(backgroundFinished(id, end, output));
  };
  return {
    /** Whether call `id` went on in the background; if so, its end is reported once its task ends. */
    moved: async (id: string, end: HookEnd): Promise<boolean> => {
      const task = backgroundTaskOf(end);
      if (task === undefined) return false;
      const ended = early.get(task) ?? early.get(id);
      if (ended === undefined) {
        running.set(task, id);
        return true;
      }
      early.delete(ended.task_id);
      if (ended.tool_use_id !== undefined) early.delete(ended.tool_use_id);
      await finish(id, ended);
      return true;
    },
    /** The calls whose commands still run in the background, which the turn waits on once it replied (#1056). */
    waiting: (): ReadonlyArray<string> => [...new Set(running.values())],
    /** A task ended: its call, if it was a background command of this turn, is reported finished. */
    ended: async (end: TaskEnd): Promise<void> => {
      let id = running.get(end.task_id);
      if (id === undefined && end.tool_use_id !== undefined && [...running.values()].includes(end.tool_use_id)) {
        id = end.tool_use_id;
      }
      if (id === undefined) {
        early.set(end.task_id, end);
        if (end.tool_use_id !== undefined) early.set(end.tool_use_id, end);
        return;
      }
      for (const [task, call] of running) if (call === id) running.delete(task);
      await finish(id, end);
    },
  };
};

export type BackgroundCommands = ReturnType<typeof backgroundCommands>;
