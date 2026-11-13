import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@hobbots/agents";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { rolloutRefusals } from "../src/codex/rollout.ts";

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

  it("[TC-PE-1356-06] reads nothing for a thread with no rollout, or one it cannot read", async () => {
    const reported: Array<RuntimeEvent> = [];
    for (const path of [null, join(folder, "missing.jsonl")]) {
      const refusals = rolloutRefusals(path, (event) => reported.push(event));
      await Effect.runPromise(Effect.andThen(refusals.start, refusals.read));
    }
    expect(reported).toEqual([]);
  });
});
