import { AttemptId, CommandId, CommandRecord, ContentId, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { visible } from "../terminal/ansi.ts";
import { transcript } from "./terminal-transcript.ts";

const command = (id: string, fields: Partial<ConstructorParameters<typeof CommandRecord>[0]> = {}) =>
  new CommandRecord({
    id: CommandId.make(id),
    attemptId: AttemptId.make("attempt-1"),
    taskId: TaskId.make("task-1"),
    stepId: `step-${id}`,
    command: `echo ${id}`,
    folder: "/Users/you/site",
    sandboxed: true,
    liveOutput: false,
    state: "succeeded",
    exitCode: 0,
    startedAt: "2026-11-02T10:00:00.000Z",
    endedAt: "2026-11-02T10:00:03.000Z",
    output: { head: `${id}\n`, tail: "", omittedBytes: 0, totalBytes: 2, logged: false },
    log: null,
    logNotKept: null,
    ...fields,
  });

const now = new Date("2026-11-02T10:00:12.000Z");
const logUrl = (each: CommandRecord) => `/log/${each.id}`;
/** The transcript's lines as the terminal shows them, without their escapes. */
const lines = (commands: ReadonlyArray<CommandRecord>, live = {}) =>
  visible(transcript({ name: "Quill", commands, live }, logUrl, now)).split("\n");

describe("a hob's scrollback", () => {
  it("starts each command with a prompt line, then what it printed and a dim line on where and how long", () => {
    const [prompt, output, end] = lines([command("a", { command: "pnpm build" })]);
    expect(prompt).toBe("quill@site $ pnpm build");
    expect(output).toBe("a");
    expect(end).toMatch(/^✓ ran in \/Users\/you\/site · in the sandbox · started .+ · took 3 sec$/);
  });

  it("keeps the colors a command printed and ends them with its output", () => {
    const text = transcript(
      {
        name: "Quill",
        commands: [
          command("a", { output: { head: "\u001b[32mok\n", tail: "", omittedBytes: 0, totalBytes: 8, logged: false } }),
        ],
        live: {},
      },
      logUrl,
      now,
    );
    expect(text).toContain("\u001b[32mok\u001b[0m\n");
  });

  it("ends a failed command with its exit code in red, and marks one run outside the sandbox", () => {
    const text = transcript(
      { name: "Quill", commands: [command("a", { state: "failed", exitCode: 2, sandboxed: false })], live: {} },
      logUrl,
      now,
    );
    expect(text).toContain("\u001b[31m✗ exit code 2\u001b[0m");
    expect(text).toContain("\u001b[31munsandboxed\u001b[0m");
  });

  it("says a line of commands only finished, and a command cut off that it is not known whether it did", () => {
    expect(lines([command("a", { command: "make; make test" })]).at(-1)).toMatch(/^Finished · an earlier part/);
    expect(lines([command("b", { state: "uncertain", endedAt: null, output: null })]).at(-1)).toMatch(
      /^\? Cut off · The turn ended while this ran/,
    );
  });

  it("shows control characters in a command line, a hob's name and a folder as typed, never as escapes", () => {
    const text = transcript(
      {
        name: "Quill\u001b[2J",
        commands: [
          command("a", {
            command: "printf '\u001b[2J\u001b[H'\necho \u001b]0;title\u0007",
            folder: "/tmp/\u001b[31mred",
          }),
        ],
        live: {},
      },
      logUrl,
      now,
    );
    for (const sequence of ["\u001b[2J", "\u001b[H", "\u001b]0;", "\u0007", "\u001b[31mred"])
      expect(text).not.toContain(sequence);
    const [prompt, more, , end] = visible(text).split("\n");
    expect(prompt).toBe("quill\u241b[2j@\u241b[31mred $ printf '\u241b[2J\u241b[H'");
    expect(more).toBe("> echo \u241b]0;title\u2407");
    expect(end).toContain("ran in /tmp/\u241b[31mred · ");
  });

  it("goes on a command of more than one line after a dim >", () => {
    expect(lines([command("a", { command: "cat <<EOF\nhi\nEOF" })]).slice(0, 3)).toEqual([
      "quill@site $ cat <<EOF",
      "> hi",
      "> EOF",
    ]);
  });

  it("folds a long output between its start and end, with a link to the whole log", () => {
    const folded = command("a", {
      output: { head: "1\n", tail: "30000\n", omittedBytes: 2048, totalBytes: 4096, logged: true },
      log: { contentId: ContentId.make("log-1"), totalBytes: 4096, omittedBytes: 0 },
    });
    const text = transcript({ name: "Quill", commands: [folded], live: {} }, logUrl, now);
    expect(text).toContain("\u001b]8;;/log/a\u0007");
    expect(lines([folded]).slice(1, 4)).toEqual([
      "1",
      "··· 2 kB left out here · Open the full log (4 kB) ···",
      "30000",
    ]);
  });

  it("shows a running command's clock as its last line while its runtime reports output only at the end", () => {
    expect(lines([command("a", { state: "running", endedAt: null, output: null })]).at(-1)).toBe(
      "● Running · 12 sec · Its output shows when it ends.",
    );
  });

  it("shows what a running command printed so far, as it comes", () => {
    const running = command("a", { state: "running", liveOutput: true, endedAt: null, output: null });
    expect(lines([running]).at(-1)).toBe("Nothing printed yet.");
    expect(lines([running], { a: { text: "one\ntw", end: 6, missed: false } }).slice(1)).toEqual(["one", "tw"]);
  });
});
