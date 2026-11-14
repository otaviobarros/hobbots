import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  clip,
  NOT_OFFERED_LABEL_MAX,
  NOT_OFFERED_NAME_MAX,
  NOT_OFFERED_TURN_MAX,
  notOfferedDenial,
  type RuntimeEvent,
  type RuntimeToolName,
} from "@hobbots/agents";
import { redactSecrets } from "@hobbots/domain";
import { Effect, Semaphore } from "effect";
import { refusedCallLabel } from "../tool-calls.ts";

/**
 * Calls to tools a Codex turn was not offered (#1356). Codex answers a call to a name it has no tool
 * for, such as a hub tool its thread was not given or a shell it was not offered, with an output of
 * its own, "unsupported call: <name>", and reports no App Server notification for it. Its thread's
 * rollout, the JSONL file Codex resumes the thread from, keeps the call and that output, so Hobbots
 * reads them from there: before it answers Codex's next request, and once each Codex turn completes.
 * An ephemeral thread keeps no rollout, so its calls are not read; no hob's turn runs on one.
 */

/** How much of the rollout one chunk reads; a line longer than this is not one Codex refuses a call with. */
export const ROLLOUT_CHUNK_BYTES = 1024 * 1024;
/** How much of the rollout one read takes at most; the rest waits for the next read. */
export const ROLLOUT_READ_BYTES = 16 * ROLLOUT_CHUNK_BYTES;
/** How many lines that may be a call or its output one read parses at most; the rest waits for the next read. */
export const ROLLOUT_READ_LINES = 1024;
/** How many reads the end of a turn takes at most to catch up, so a rollout gained a lot is read to its end. */
export const ROLLOUT_DRAIN_READS = 16;
/** How many refused calls one turn's rollout reports at most; past it a rollout the hob wrote adds none. */
export const ROLLOUT_REFUSALS_MAX = NOT_OFFERED_TURN_MAX;
/** How many calls still waiting for their output are kept; the oldest is dropped past it. */
const PENDING_CALLS = 256;
/** Opens the rollout only as itself, never through a symlink, nor waiting on a pipe put in its place. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The outputs Codex answers a call to a tool it has none of with. */
const UNSUPPORTED = ["unsupported call: ", "unsupported custom tool call: "];

/** The runtime tool each of Codex's own tools belongs to, as a session's offer names them (#1348). */
const RUNTIME_TOOLS: ReadonlyMap<string, RuntimeToolName> = new Map([
  ["shell", "commands"],
  ["local_shell", "commands"],
  ["exec_command", "commands"],
  ["write_stdin", "commands"],
  ["apply_patch", "file_edits"],
  ["view_image", "file_reads"],
]);

/** What every line holding a call or its output has, as Codex writes it: its type, quoted, starting so. */
const MARKERS = [Buffer.from('"function_call'), Buffer.from('"custom_tool_call')];

/**
 * Passes each line of `lines`, whole lines only, that holds a marker to `each`, while `budget` lasts,
 * and returns how many bytes it read past: all of them, or up to the end of the last line it passed
 * when the budget ran out. A line without a marker is never decoded, so a run of them costs a search.
 */
const scanLines = (lines: Buffer, budget: { lines: number }, each: (line: string) => void) => {
  let at = 0;
  // Where each marker is next found; one is searched for again only once the read has passed it.
  const next = MARKERS.map((marker) => lines.indexOf(marker));
  while (budget.lines > 0) {
    for (const [index, marker] of MARKERS.entries())
      if (next[index] !== -1 && (next[index] ?? -1) < at) next[index] = lines.indexOf(marker, at);
    const hits = next.filter((hit) => hit !== -1);
    if (hits.length === 0) return lines.length;
    const hit = Math.min(...hits);
    const stop = lines.indexOf(0x0a, hit);
    each(lines.toString("utf8", lines.lastIndexOf(0x0a, hit) + 1, stop));
    budget.lines -= 1;
    at = stop + 1;
  }
  return at;
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
const labelOf = (
  tool: string,
  runtimeTool: RuntimeToolName | null,
  call: ResponseItem | undefined,
  redact: ((text: string) => string) | undefined,
) => {
  const input = call === undefined ? {} : inputOf(call);
  const command = input.cmd ?? input.command;
  const line = Array.isArray(command) ? command.filter((word) => typeof word === "string").join(" ") : command;
  return runtimeTool === "commands" && typeof line === "string"
    ? refusedCallLabel("Bash", { command: line }, redact)
    : refusedCallLabel(tool, input, redact);
};

/**
 * Reads the calls Codex answered as unsupported from what its thread's rollout gains, as it gains
 * it: the calls of a Codex turn arrive before the hub hears of the model's next call, and those of
 * a call it makes last once the turn has completed. Each read takes the whole lines appended since
 * the last; a call and its output may be read apart. Codex's requests are answered concurrently, so
 * reads take turns: each one starts where the last ended and reports what it read before the next.
 *
 * The rollout lives in the session's Codex home, which the hob's commands can write, so it is read
 * as untrusted input (STD-SEC-002): never through a symlink or from anything but a regular file, a
 * bounded chunk at a time, at most a bounded amount and a bounded number of parsed lines per read,
 * only a line that may be a call or its output decoded, a line longer than a chunk skipped, and a
 * rollout that shrank read on from its new end.
 */
export const rolloutRefusals = (
  path: string | null | undefined,
  report: (event: RuntimeEvent) => void,
  redact: (text: string) => string = redactSecrets,
) => {
  /** A name as a refusal keeps it: redacted whole, then bounded, so a secret it holds is never cut first. */
  const nameOf = (name: string) => clip(redact(name), NOT_OFFERED_NAME_MAX);
  /** Only what a refusal needs of each call waiting for its output, each bounded, never the call itself. */
  const calls = new Map<
    string,
    { readonly tool: string; readonly runtimeTool: RuntimeToolName | null; readonly label: string }
  >();
  let offset: number | null = null;
  let reported = 0;
  const turns = Semaphore.makeUnsafe(1);
  /** Keeps a call until its output is read, dropping the oldest past PENDING_CALLS. */
  const keep = (id: string, item: ResponseItem) => {
    if (typeof item.name !== "string") return;
    // A name is the model's or the rollout's own text, so only a name in the map is a runtime tool.
    const runtimeTool = RUNTIME_TOOLS.get(item.name) ?? null;
    const tool = nameOf(item.name);
    const label = clip(labelOf(tool, runtimeTool, item, redact), NOT_OFFERED_LABEL_MAX);
    calls.set(id, { tool, runtimeTool, label });
    const oldest = calls.size > PENDING_CALLS ? calls.keys().next() : null;
    if (oldest !== null && oldest.done !== true) calls.delete(oldest.value);
  };
  /** The refusal an output reports, if it is Codex's answer to a call it has no tool for. */
  const refusalOf = (id: string, output: unknown) => {
    const call = calls.get(id);
    calls.delete(id);
    const prefix = typeof output === "string" ? UNSUPPORTED.find((each) => output.startsWith(each)) : undefined;
    if (prefix === undefined || typeof output !== "string" || reported >= ROLLOUT_REFUSALS_MAX) return null;
    reported += 1;
    const named = output.slice(prefix.length).trim();
    const tool = call?.tool ?? nameOf(named);
    const runtimeTool = call?.runtimeTool ?? RUNTIME_TOOLS.get(named) ?? null;
    const label = call?.label ?? labelOf(tool, runtimeTool, undefined, redact);
    return notOfferedDenial({ id, tool, label, runtimeTool });
  };
  /** Reports the refusal one line holds, if it is Codex's answer to a call it has no tool for. */
  const readLine = (line: string) => {
    const item = itemOf(line);
    if (item === null || typeof item.call_id !== "string") return;
    // The id is the rollout's own text too, so it is kept as a name is: redacted whole, then bounded.
    const id = nameOf(item.call_id);
    if (item.type === "function_call" || item.type === "custom_tool_call") keep(id, item);
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return;
    const refusal = refusalOf(id, item.output);
    if (refusal !== null) report(refusal);
  };
  /**
   * Reads on from `offset`, a chunk at a time and at most ROLLOUT_READ_BYTES and ROLLOUT_READ_LINES of
   * it, moving `offset` past each whole line it has read, and says whether it stopped at a bound with
   * more to read. Only a line that may be a call or its output is decoded and parsed, as it is found,
   * so what the hob writes costs at most a bounded amount of work per read. A rollout that shrank is
   * read on from its new end.
   */
  const readFrom = async (file: string, from: number) => {
    const handle = await open(file, OPEN_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return false;
      if (info.size < from) {
        offset = info.size;
        return false;
      }
      const buffer = Buffer.alloc(Math.min(ROLLOUT_CHUNK_BYTES, info.size - from));
      const budget = { lines: ROLLOUT_READ_LINES };
      let end = from;
      while (end < info.size && end - from < ROLLOUT_READ_BYTES && budget.lines > 0) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - end), end);
        if (bytesRead === 0) break;
        const whole = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
        // A line Codex is still writing waits for the next read; one longer than a chunk is skipped.
        if (whole === 0 && bytesRead < ROLLOUT_CHUNK_BYTES) break;
        end += whole === 0 ? bytesRead : scanLines(buffer.subarray(0, whole), budget, readLine);
        offset = end;
      }
      return end < info.size && (end - from >= ROLLOUT_READ_BYTES || budget.lines === 0);
    } finally {
      await handle.close();
    }
  };
  /** One read: reports what it read, and whether the rollout has more past where it stopped. */
  const readOnce = Effect.suspend(() => {
    if (path == null || offset === null) return Effect.succeed(false);
    const from = offset;
    return Effect.tryPromise(() => readFrom(path, from)).pipe(Effect.orElseSucceed(() => false));
  });
  return {
    /** Starts reading where the rollout ends now, so only what this turn's run appends is read. */
    start: Semaphore.withPermit(
      turns,
      Effect.suspend(() =>
        path == null || offset !== null
          ? Effect.void
          : Effect.tryPromise(() => lstat(path)).pipe(
              Effect.map((info) => (info.isFile() ? info.size : 0)),
              Effect.orElseSucceed(() => 0),
              Effect.flatMap((end) =>
                Effect.sync(() => {
                  offset = end;
                }),
              ),
            ),
      ),
    ),
    /** Reports the unsupported calls in what the rollout gained since the last read; a rollout it cannot read adds none. */
    read: Semaphore.withPermit(turns, readOnce),
    /**
     * Reads as `read` does until the rollout is read to its end, at most ROLLOUT_DRAIN_READS reads,
     * so a turn that ends after its rollout gained more than one read takes is still read whole.
     */
    drain: Semaphore.withPermit(
      turns,
      Effect.gen(function* () {
        for (let reads = 0; reads < ROLLOUT_DRAIN_READS; reads += 1) if (!(yield* readOnce)) return;
      }),
    ),
  };
};
