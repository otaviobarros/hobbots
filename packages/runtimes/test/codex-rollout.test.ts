import { appendFileSync, mkdtempSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_OFFERED_LABEL_MAX, NOT_OFFERED_NAME_MAX, type RuntimeEvent } from "@hobbots/agents";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  ROLLOUT_CHUNK_BYTES,
  ROLLOUT_DRAIN_READS,
  ROLLOUT_READ_BYTES,
  ROLLOUT_REFUSALS_MAX,
  rolloutRefusals,
} from "../src/codex/rollout.ts";

// What Codex 0.166.0 to 0.169.0 write to a thread's rollout for a call to a tool it has none of
// (#1356): the model's call, then the output Codex answers it with, as response items.
const folder = mkdtempSync(join(tmpdir(), "hobbots-rollout-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const line = (payload: Record<string, unknown>) => `${JSON.stringify({ type: "response_item", payload })}\n`;
const call = (id: string, name: string, args: object) =>
  line({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });
const output = (id: string, text: string) => line({ type: "function_call_output", call_id: id, output: text });

describe("calls a Codex thread was not offered, from its rollout (#1356)", () => {
  // covers PE-001, ADR 014 (#1356)
  it("[TC-PE-1356-05] reads each call Codex answered as unsupported once, from what the rollout gained since it started", async () => {
    const path = join(folder, "rollout.jsonl");
    // What an earlier turn left is not this turn's.
    writeFileSync(
      path,
      `${line({ type: "session_meta" })}${call("old", "github_comment", {})}${output("old", "unsupported call: github_comment")}`,
    );
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    appendFileSync(
      path,
      [
        call("c-1", "github_review", { body: "Approve." }),
        call("c-2", "exec_command", { cmd: "git diff" }),
        output("c-2", "unsupported call: exec_command"),
        call("c-3", "read_tasks", {}),
        output("c-3", "Read."),
      ].join(""),
    );
    // A line Codex is still writing waits for the next read.
    appendFileSync(path, output("c-1", "unsupported call: github_review").slice(0, 20));
    await Effect.runPromise(refusals.read);
    appendFileSync(path, output("c-1", "unsupported call: github_review").slice(20));
    await Effect.runPromise(refusals.read);
    await Effect.runPromise(refusals.read);
    expect(reported).toEqual([
      expect.objectContaining({
        _tag: "ToolDenied",
        id: "c-2",
        tool: "exec_command",
        operation: "run-commands",
        label: "Running git diff",
        notOffered: { runtimeTool: "commands" },
      }),
      expect.objectContaining({ id: "c-1", tool: "github_review", notOffered: { runtimeTool: null } }),
    ]);
  });

  it("[TC-PE-1356-08] reports each call once when reads overlap, and never reads back past where the last one ended", async () => {
    const path = join(folder, "overlapping.jsonl");
    writeFileSync(path, line({ type: "session_meta" }));
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    const refused = (ids: ReadonlyArray<string>) =>
      ids.map((id) => `${call(id, "github_comment", {})}${output(id, "unsupported call: github_comment")}`).join("");
    // Codex's requests are answered at once, each reading the rollout first.
    const overlapping = Effect.all(
      Array.from({ length: 8 }, () => refusals.read),
      { concurrency: "unbounded" },
    );
    appendFileSync(path, refused(["a-1", "a-2", "a-3"]));
    await Effect.runPromise(overlapping);
    appendFileSync(path, refused(["b-1"]));
    await Effect.runPromise(overlapping);
    expect(reported.map((event) => (event._tag === "ToolDenied" ? event.id : event._tag))).toEqual([
      "a-1",
      "a-2",
      "a-3",
      "b-1",
    ]);
  });

  // covers SEC-002, ADR 014 (#1356)
  it("[TC-PE-1356-09] reads a rollout the hob's commands can write as untrusted: no symlink, a bounded amount per read, a shrunk file read on from its end", async () => {
    const refused = (id: string) =>
      `${call(id, "github_comment", {})}${output(id, "unsupported call: github_comment")}`;
    const idsOf = (events: ReadonlyArray<RuntimeEvent>) =>
      events.map((event) => (event._tag === "ToolDenied" ? event.id : event._tag));

    // A symlink put in the rollout's place is never followed.
    const target = join(folder, "elsewhere.jsonl");
    writeFileSync(target, "");
    const linked = join(folder, "linked.jsonl");
    symlinkSync(target, linked);
    const viaLink: Array<RuntimeEvent> = [];
    const link = rolloutRefusals(linked, (event) => viaLink.push(event));
    await Effect.runPromise(link.start);
    appendFileSync(target, refused("via-link"));
    await Effect.runPromise(link.read);
    expect(viaLink).toEqual([]);

    // A file grown far past what one read takes, with a line longer than a chunk, is read a bounded
    // amount at a time, and the refusals past the long line are still read.
    const path = join(folder, "untrusted.jsonl");
    writeFileSync(path, "");
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    appendFileSync(path, `${"x".repeat(ROLLOUT_CHUNK_BYTES + 10)}\n${refused("after-long")}`);
    await Effect.runPromise(refusals.read);
    expect(idsOf(reported)).toEqual(["after-long"]);
    const grown = statSync(path).size;
    truncateSync(path, grown + 3 * ROLLOUT_READ_BYTES);
    appendFileSync(path, `\n${refused("far")}`);
    await Effect.runPromise(refusals.read);
    expect(idsOf(reported)).toEqual(["after-long"]);
    for (let each = 0; each < 3; each += 1) await Effect.runPromise(refusals.read);
    expect(idsOf(reported)).toEqual(["after-long", "far"]);

    // A rollout cut short is read on from its new end, and what was read is never read again.
    writeFileSync(path, refused("after-long"));
    await Effect.runPromise(refusals.read);
    appendFileSync(path, refused("after-cut"));
    await Effect.runPromise(refusals.read);
    expect(idsOf(reported)).toEqual(["after-long", "far", "after-cut"]);
  });

  // covers PE-001, ADR 014 (#1356)
  it("[TC-PE-1356-10] the end of a turn reads its rollout to the end, though it gained more than one read takes", async () => {
    const path = join(folder, "drained.jsonl");
    writeFileSync(path, "");
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    const far = `${call("far", "github_comment", {})}${output("far", "unsupported call: github_comment")}`;
    truncateSync(path, 3 * ROLLOUT_READ_BYTES);
    appendFileSync(path, `\n${far}`);
    await Effect.runPromise(refusals.drain);
    expect(reported.map((event) => (event._tag === "ToolDenied" ? event.id : event._tag))).toEqual(["far"]);
    // A drain is bounded too: what lies past its last read waits for the next.
    const beyond = join(folder, "beyond.jsonl");
    writeFileSync(beyond, "");
    const past: Array<RuntimeEvent> = [];
    const bounded = rolloutRefusals(beyond, (event) => past.push(event));
    await Effect.runPromise(bounded.start);
    truncateSync(beyond, (ROLLOUT_DRAIN_READS + 1) * ROLLOUT_READ_BYTES);
    appendFileSync(beyond, `\n${far}`);
    await Effect.runPromise(bounded.drain);
    expect(past).toEqual([]);
    await Effect.runPromise(bounded.drain);
    expect(past).toHaveLength(1);
  });

  // covers PE-001, SEC-002, ADR 014 (#1356)
  it("[TC-PE-1356-11] a refused call named as an Object property is no runtime tool, and is decided as an unknown one", async () => {
    const path = join(folder, "names.jsonl");
    writeFileSync(path, "");
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty"];
    appendFileSync(
      path,
      names.map((name) => `${call(name, name, {})}${output(name, `unsupported call: ${name}`)}`).join(""),
    );
    await Effect.runPromise(refusals.read);
    expect(reported).toEqual(
      names.map((name) =>
        expect.objectContaining({
          id: name,
          tool: name,
          operation: "outside-folders",
          notOffered: { runtimeTool: null },
        }),
      ),
    );
  });

  // covers SEC-002, ADR 014 (#1356)
  it("[TC-PE-1356-12] a rollout the hob filled with refused calls under long names reports a bounded number of them, each bounded", async () => {
    const path = join(folder, "flood.jsonl");
    writeFileSync(path, "");
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    const name = "n".repeat(100_000);
    const pairs = Array.from(
      { length: ROLLOUT_REFUSALS_MAX * 2 },
      (_, each) =>
        `${call(`c-${each}`, name, { command: "x".repeat(100_000) })}${output(`c-${each}`, `unsupported call: ${name}`)}`,
    );
    appendFileSync(path, pairs.join(""));
    await Effect.runPromise(refusals.drain);
    expect(reported).toHaveLength(ROLLOUT_REFUSALS_MAX);
    for (const event of reported) {
      if (event._tag !== "ToolDenied") throw new Error(event._tag);
      expect(event.tool.length).toBeLessThanOrEqual(NOT_OFFERED_NAME_MAX);
      expect(event.label.length).toBeLessThanOrEqual(NOT_OFFERED_LABEL_MAX);
      expect(event.reason.length).toBeLessThan(NOT_OFFERED_NAME_MAX + 100);
    }
  });

  // covers SEC-001, SEC-002, ADR 014 (#1356)
  it("[TC-PE-1356-13] a refused call's label is redacted with the turn's redactor before it is shortened, and input it cannot read gives a plain label", async () => {
    const path = join(folder, "labels.jsonl");
    writeFileSync(path, "");
    const secret = "plain-known-value-7f3a9c";
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(
      path,
      (event) => reported.push(event),
      (text) => text.replaceAll(secret, "[secret]"),
    );
    await Effect.runPromise(refusals.start);
    // The secret straddles where a command's label is cut.
    const command = `echo ${"a".repeat(80)} ${secret} done`;
    appendFileSync(
      path,
      [
        call("c-1", "exec_command", { cmd: command }),
        output("c-1", "unsupported call: exec_command"),
        call("c-2", "apply_patch", { changes: [null] }),
        output("c-2", "unsupported call: apply_patch"),
      ].join(""),
    );
    await Effect.runPromise(refusals.read);
    const labels = reported.map((event) => (event._tag === "ToolDenied" ? event.label : event._tag));
    expect(labels).toHaveLength(2);
    expect(labels[0]).not.toContain(secret.slice(0, 8));
    expect(labels[1]).toBe("Using apply_patch");
  });

  // covers SEC-002, ADR 014 (#1356)
  it("[TC-PE-1356-15] a rollout the hob filled with empty lines is read past them, and the refusal after them is reported", async () => {
    const path = join(folder, "blank.jsonl");
    writeFileSync(path, "");
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    appendFileSync(
      path,
      `${"\n".repeat(2 * ROLLOUT_CHUNK_BYTES)}${call("after", "github_comment", {})}${output("after", "unsupported call: github_comment")}`,
    );
    await Effect.runPromise(refusals.drain);
    expect(reported.map((event) => (event._tag === "ToolDenied" ? event.id : event._tag))).toEqual(["after"]);
  });

  // covers SEC-002, ADR 014 (#1356)
  it("[TC-PE-1356-16] a call waiting for its output keeps only its bounded name and label, whatever its arguments hold", async () => {
    const path = join(folder, "pending.jsonl");
    writeFileSync(path, "");
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(path, (event) => reported.push(event));
    await Effect.runPromise(refusals.start);
    // Calls whose arguments nest far more than any label needs, waiting for an output.
    const nested = { cmd: `git ${"x".repeat(50_000)}`, more: Array.from({ length: 2_000 }, (_, each) => ({ each })) };
    appendFileSync(path, Array.from({ length: 300 }, (_, each) => call(`p-${each}`, "exec_command", nested)).join(""));
    await Effect.runPromise(refusals.drain);
    appendFileSync(path, output("p-299", "unsupported call: exec_command"));
    await Effect.runPromise(refusals.read);
    expect(reported).toEqual([
      expect.objectContaining({ id: "p-299", tool: "exec_command", notOffered: { runtimeTool: "commands" } }),
    ]);
    const [denied] = reported;
    expect(denied?._tag === "ToolDenied" ? denied.label.length : 0).toBeLessThanOrEqual(NOT_OFFERED_LABEL_MAX);
    expect(denied?._tag === "ToolDenied" ? denied.label : "").toMatch(/^Running git x+/);
  });

  // covers SEC-002, ADR 014 (#1356)
  it("[TC-PE-1356-17] a refused call's name is redacted whole before it is shortened, from its call or only its output", async () => {
    const path = join(folder, "names.jsonl");
    writeFileSync(path, "");
    const secret = "plain-known-value-7f3a9c";
    const reported: Array<RuntimeEvent> = [];
    const refusals = rolloutRefusals(
      path,
      (event) => reported.push(event),
      (text) => text.replaceAll(secret, "[secret]"),
    );
    await Effect.runPromise(refusals.start);
    // The secret straddles where a name is cut.
    const name = `${"n".repeat(NOT_OFFERED_NAME_MAX - 16)}${secret}`;
    appendFileSync(
      path,
      [
        call("n-1", name, {}),
        output("n-1", `unsupported call: ${name}`),
        output("n-2", `unsupported call: ${name}`),
      ].join(""),
    );
    await Effect.runPromise(refusals.read);
    expect(reported).toHaveLength(2);
    for (const event of reported) {
      const kept = event._tag === "ToolDenied" ? [event.tool, event.label, event.reason].join(" ") : "";
      expect(kept).not.toContain(secret.slice(0, 8));
    }
  });

  it("[TC-PE-1356-06] reads nothing for a thread with no rollout, or one it cannot read", async () => {
    const reported: Array<RuntimeEvent> = [];
    for (const path of [null, join(folder, "missing.jsonl")]) {
      const refusals = rolloutRefusals(path, (event) => reported.push(event));
      await Effect.runPromise(Effect.andThen(refusals.start, refusals.read));
    }
    expect(reported).toEqual([]);
  });
});
