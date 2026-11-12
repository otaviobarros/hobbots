import type { HubTools, RuntimeEvent, TurnSteers } from "@hobbots/agents";
import { Effect, Exit, Queue, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_STEERED } from "../src/fake.ts";
import { type HubCallRuntime, hubCallRuntimes } from "../src/testing/hub-call-turns.ts";

// Issue #1345: a lead's message that arrives while its member's turn runs reaches the member's model
// at the turn's next step, between two tool calls, on every runtime Hobbots serves. Claude Code and
// Codex run here when `HOBBOTS_CLAUDE_CODE` and `HOBBOTS_CODEX` name their binaries, against a
// stand-in model; the fake always runs.

const STEER = "Write the report to ./reports, not ./out.";
const FIRST_ANSWER = "Listed the files.";
const SECOND_ANSWER = "Wrote the report.";

let all: Awaited<ReturnType<typeof hubCallRuntimes>>;
beforeAll(async () => {
  all = await hubCallRuntimes();
});
afterAll(() => all.close());

/**
 * A turn that calls `list_files` then `write_report`, with a message that arrives while the first
 * call runs. Returns the turn's events and what the hub recorded of the hand-off.
 */
const steeredTurn = async (runtime: HubCallRuntime) => {
  const arrived = Effect.runSync(Queue.sliding<void>(1));
  let waiting = false;
  const handed: Array<{ readonly text: string; readonly took: boolean }> = [];
  const calls: Array<string> = [];
  const steers: TurnSteers = {
    waiting: Stream.fromQueue(arrived),
    deliver: (handOff) =>
      Effect.suspend(() => {
        if (!waiting) return Effect.void;
        return Effect.map(handOff(STEER), (took) => {
          handed.push({ text: STEER, took });
          if (took) waiting = false;
        });
      }),
  };
  const hubTools: HubTools = {
    tools: [
      { name: "list_files", description: "List the files.", label: "Listing", inputSchema: { type: "object" } },
      { name: "write_report", description: "Write the report.", label: "Writing", inputSchema: { type: "object" } },
    ],
    call: (name) =>
      Effect.gen(function* () {
        calls.push(name);
        if (name !== "list_files") return { text: SECOND_ANSWER, refused: false };
        // The lead's message arrives while the first call runs.
        waiting = true;
        yield* Queue.offer(arrived, undefined);
        return { text: FIRST_ANSWER, refused: false };
      }),
  };
  const events = await Effect.runPromise(
    Stream.runCollect(
      runtime.events(
        {
          prompt: "",
          sessionId: null,
          instructions: "",
          instructionsChanged: false,
          model: null,
          effort: null,
          hubTools,
          recordToolStart: null,
          steers,
        },
        [
          { tool: "list_files", input: {} },
          { tool: "write_report", input: {} },
        ],
      ),
    ).pipe(Effect.exit),
  );
  return { events, handed, calls };
};

const completedText = (exit: Exit.Exit<ReadonlyArray<RuntimeEvent>, unknown>) =>
  Exit.isSuccess(exit) ? exit.value.flatMap((event) => (event._tag === "Completed" ? [event.text] : []))[0] : undefined;

describe("a message that reaches a running turn", () => {
  // covers OR-007, RT-002
  it("[TC-RT-1345-01] reaches the model after the call it arrived during and before the next call, on each runtime", async () => {
    for (const runtime of all.runtimes) {
      const { events, handed, calls } = await steeredTurn(runtime);
      expect(Exit.isSuccess(events), runtime.name).toBe(true);
      expect(calls, runtime.name).toEqual(["list_files", "write_report"]);
      // Handed over once, and the runtime took it.
      expect(handed, runtime.name).toEqual([{ text: STEER, took: true }]);
      if (runtime.name === "fake") {
        // The fake's reply lists what reached it in order: the first call, the message, the second call.
        const text = completedText(events) ?? "";
        const order = [`list_files: ${FIRST_ANSWER}`, `${FAKE_STEERED}${STEER}`, `write_report: ${SECOND_ANSWER}`].map(
          (part) => text.indexOf(part),
        );
        expect(
          order.every((index) => index >= 0),
          runtime.name,
        ).toBe(true);
        expect(order, runtime.name).toEqual([...order].sort((a, b) => a - b));
        continue;
      }
      // The first request that carries the message carries the first call's answer and not the
      // second's: the model read it before it made the second call.
      const requests = runtime.modelRequests();
      const first = requests.find((request) => request.includes(STEER));
      expect(first, runtime.name).toBeDefined();
      expect(first?.includes(FIRST_ANSWER), runtime.name).toBe(true);
      expect(first?.includes(SECOND_ANSWER), runtime.name).toBe(false);
    }
  }, 120_000);
});
