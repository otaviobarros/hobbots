import { open, stat } from "node:fs/promises";
import { notOfferedDenial, type RuntimeEvent, type RuntimeToolName } from "@hobbots/agents";
import { Effect } from "effect";
import { toolLabel } from "../tool-calls.ts";

/**
 * Calls to tools a Codex turn was not offered (#1356). Codex answers a call to a name it has no tool
 * for, such as a hub tool its thread was not given or a shell it was not offered, with an output of
 * its own, "unsupported call: <name>", and reports no App Server notification for it. Its thread's
 * rollout, the JSONL file Codex resumes the thread from, keeps the call and that output, so Hobbots
 * reads them from there: before it answers Codex's next request, and once each Codex turn completes.
 * An ephemeral thread keeps no rollout, so its calls are not read; no hob's turn runs on one.
 */

/** The outputs Codex answers a call to a tool it has none of with. */
const UNSUPPORTED = ["unsupported call: ", "unsupported custom tool call: "];

/** The runtime tool each of Codex's own tools belongs to, as a session's offer names them (#1348). */
const RUNTIME_TOOLS: Readonly<Record<string, RuntimeToolName>> = {
  shell: "commands",
  local_shell: "commands",
  exec_command: "commands",
  write_stdin: "commands",
  apply_patch: "file_edits",
  view_image: "file_reads",
};

interface ResponseItem {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly call_id?: unknown;
  readonly arguments?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
}

const itemOf = (line: string): ResponseItem | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return null;
    const { type, payload } = parsed as { readonly type?: unknown; readonly payload?: unknown };
    return type === "response_item" && payload !== null && typeof payload === "object"
      ? (payload as ResponseItem)
      : null;
  } catch {
    return null;
  }
};

/** A function call's arguments, a JSON object as text; a custom call's input is its own text. */
const inputOf = (item: ResponseItem): Record<string, unknown> => {
  if (typeof item.arguments !== "string") return {};
  try {
    const input: unknown = JSON.parse(item.arguments);
    return input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** A refused call's step label: a command by its command line, as Codex's own commands show. */
const labelOf = (tool: string, runtimeTool: RuntimeToolName | null, call: ResponseItem | undefined) => {
  const input = call === undefined ? {} : inputOf(call);
  const command = input.cmd ?? input.command;
  const line = Array.isArray(command) ? command.filter((word) => typeof word === "string").join(" ") : command;
  return runtimeTool === "commands" && typeof line === "string"
    ? toolLabel("Bash", { command: line })
    : toolLabel(tool, input);
};

/**
 * Reads the calls Codex answered as unsupported from what its thread's rollout gains, as it gains
 * it: the calls of a Codex turn arrive before the hub hears of the model's next call, and those of
 * a call it makes last once the turn has completed. Each read takes the whole lines appended since
 * the last; a call and its output may be read apart.
 */
export const rolloutRefusals = (path: string | null | undefined, report: (event: RuntimeEvent) => void) => {
  const calls = new Map<string, ResponseItem>();
  let offset: number | null = null;
  const refusedIn = (lines: ReadonlyArray<string>) => {
    for (const line of lines) {
      const item = itemOf(line);
      if (item === null || typeof item.call_id !== "string") continue;
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        calls.set(item.call_id, item);
        continue;
      }
      if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") continue;
      const call = calls.get(item.call_id);
      calls.delete(item.call_id);
      const output = item.output;
      const prefix = typeof output === "string" ? UNSUPPORTED.find((each) => output.startsWith(each)) : undefined;
      if (prefix === undefined || typeof output !== "string") continue;
      const tool = typeof call?.name === "string" ? call.name : output.slice(prefix.length).trim();
      const runtimeTool = RUNTIME_TOOLS[tool] ?? null;
      report(notOfferedDenial({ id: item.call_id, tool, label: labelOf(tool, runtimeTool, call), runtimeTool }));
    }
  };
  /** The whole lines appended past `from`, and where the last of them ends. */
  const appended = async (file: string, from: number) => {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size <= from) return { lines: [], end: from };
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const whole = buffer.lastIndexOf(0x0a) + 1;
      return {
        lines: buffer
          .subarray(0, whole)
          .toString("utf8")
          .split("\n")
          .filter((line) => line.trim() !== ""),
        end: from + whole,
      };
    } finally {
      await handle.close();
    }
  };
  return {
    /** Starts reading where the rollout ends now, so only what this turn's run appends is read. */
    start: Effect.suspend(() =>
      path == null || offset !== null
        ? Effect.void
        : Effect.tryPromise(() => stat(path)).pipe(
            Effect.map((info) => info.size),
            Effect.orElseSucceed(() => 0),
            Effect.flatMap((end) =>
              Effect.sync(() => {
                offset = end;
              }),
            ),
          ),
    ),
    /** Reports the unsupported calls in what the rollout gained since the last read; a rollout it cannot read adds none. */
    read: Effect.suspend(() => {
      if (path == null || offset === null) return Effect.void;
      const from = offset;
      return Effect.tryPromise(() => appended(path, from)).pipe(
        Effect.flatMap(({ lines, end }) =>
          Effect.sync(() => {
            offset = end;
            refusedIn(lines);
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      );
    }),
  };
};
