import { ChatService, HobbotsRepository, operationDecision, type PromptRequest } from "@hobbots/agents";
import { Agent, EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  attemptsOf,
  holdStarted,
  hub,
  memberTask,
  promptsTo,
  ROOK,
  send,
  settledTree,
  sharedDatabase,
  startHub,
  taskOf,
  treeWhen,
} from "./dependency-hub.ts";

// Issue #1347: a change to a hob's answers applies from its next turn, in a chat or a Task alike,
// and a turn already running keeps what it started with unless the change takes something away.
// The hub reads the answers when each turn starts and decides each command on them, on every
// runtime (ADR 014); here on the fake runtime, on SQLite and PostgreSQL (TestDatabase).

const NO_COMMANDS: HobPolicy = { ...EMPTY_HOB_POLICY, overrides: { "run-commands": "deny" } };

/**
 * Gives Rook alone `policy`, as a new configuration version. His lead keeps its own, so the
 * Delegation it gives him carries no restriction of its own (ADR 018).
 */
const giveRook = (policy: HobPolicy) =>
  HobbotsRepository.use((repo) =>
    Effect.gen(function* () {
      const agent = Option.getOrThrow(yield* repo.findAgent(ROOK));
      yield* repo.updateAgentConfig(new Agent({ ...agent, policy, configVersion: agent.configVersion + 1 }));
    }),
  );

/** What the turn was given for Run commands. */
const commands = (request: PromptRequest | undefined) =>
  request?.tools == null ? undefined : operationDecision(request.tools.policy, "run-commands");

describe("a change to a member's answers", () => {
  // covers PE-005, PE-008, OR-004
  it("[TC-PE-1347-01] Run commands widened between two turns of one Task reaches the second turn", async () => {
    const { run, requests } = await startHub(await sharedDatabase(), [
      {
        on: "was answered by hob aldric",
        lines: [hub("complete_task", { delivered: true, key: "tests-done", summary: "The tests pass" })],
      },
    ]);
    await run(giveRook(NO_COMMANDS));
    await run(
      send([
        "Test the app",
        hub("delegate_task", {
          key: "tests",
          hob: "Rook",
          brief: ["Run the tests", hub("ask", { key: "which", question: "Which suite?" })].join("\n"),
        }),
      ]),
    );
    await run(treeWhen((tree) => tree.questions.length === 1 && memberTask(tree, ROOK)?.state === "waiting"));
    // You allow Run commands while Rook waits for his answer.
    await run(giveRook(EMPTY_HOB_POLICY));
    await run(send(["Answer Rook", hub("answer", { key: "reply", question_id: "$which.question_id", answer: "All" })]));
    const done = await run(settledTree((tree) => memberTask(tree, ROOK)?.state === "completed"));
    const rook = taskOf(done, ROOK);
    const [first, second, ...more] = promptsTo(requests, rook);
    expect(more).toEqual([]);
    // The second turn goes on in the first one's session; only it has Run commands.
    expect(second?.sessionId).not.toBeNull();
    expect(commands(first)).toBe("deny");
    expect(commands(second)).not.toBe("deny");
  }, 30_000);

  // covers PE-005, PE-008
  it("[TC-PE-1347-02] a turn running when Run commands is widened keeps what it started with and is not stopped", async () => {
    const { run, requests, release } = await startHub(await sharedDatabase());
    await run(giveRook(NO_COMMANDS));
    await run(
      send([
        "Test the app",
        hub("delegate_task", {
          key: "tests",
          hob: "Rook",
          brief: [
            "Run the tests",
            holdStarted("rook"),
            hub("complete_task", { delivered: true, key: "tests-done", summary: "The tests pass" }),
          ].join("\n"),
        }),
      ]),
    );
    const started = await run(
      treeWhen((tree) => {
        const task = memberTask(tree, ROOK);
        return task !== undefined && tree.attempts.some((each) => each.taskId === task.id && each.state === "running");
      }),
    );
    // A widening takes nothing away, so reviewing the running turns leaves Rook's running.
    await run(giveRook(EMPTY_HOB_POLICY));
    await run(ChatService.use((chat) => chat.reviewAuthority(ROOK)));
    await release("rook");
    const done = await run(settledTree((tree) => memberTask(tree, ROOK)?.state === "completed"));
    const rook = taskOf(done, ROOK);
    expect(rook.id).toBe(taskOf(started, ROOK).id);
    expect(attemptsOf(done, rook)).toEqual(["completed"]);
    const turns = promptsTo(requests, rook);
    expect(turns).toHaveLength(1);
    expect(commands(turns[0])).toBe("deny");
  }, 30_000);
});
