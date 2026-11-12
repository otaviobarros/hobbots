import { ChatService, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import { type ChapterId, isLiveAttempt, type RuntimeKind, ThreadId } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { continuations, hub, ownedBy, PIP, partyHub, send, threadId, treeWhen } from "./party-hub.ts";

// Issue #1389 (ADR 037, Quests in camps): a quest belongs to the chat or camp that started it, and
// moves with the chapter that started it. A quest still running when its chapter moves goes on in
// the camp: its member's result reaches the lead there, and the lead's next turn runs in the camp,
// never in the chat. The hub routes it, so it holds for every runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];
const CAMP = ThreadId.make("skills-camp");

describe.each(RUNTIMES)("a quest whose chapter moves into a camp, on %s", (runtime) => {
  // covers CH-009, OR-004, IN-004, RT-001
  it("[TC-CH-1389-03] moves whole while its member works, and the lead's next turn, with the member's result, runs in the camp", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, gates, requests } = party;
    // Pip returns the page only once the test lets him, so the quest is still running when it moves.
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    gates.set("pip", () => opened);
    await run(
      send([
        "Explain the Skills feature",
        hub("delegate_task", {
          key: "page",
          hob: "Pip",
          brief: [
            "Write the Skills explainer",
            hub("complete_task", { key: "pip", summary: "The page is written" }),
          ].join("\n"),
        }),
      ]),
    );
    // Frodo's reply has ended and Pip is at work.
    await run(
      treeWhen((tree) => {
        const pip = ownedBy(tree, PIP);
        return tree.attempts.some((each) => each.taskId === pip?.id && isLiveAttempt(each.state));
      }),
    );
    await run(
      waitUntil(
        HobbotsRepository.use((repo) => repo.listMessages(threadId)),
        (all) => all.length > 0 && all.every((m) => m.status === "complete"),
        { what: "Frodo's reply" },
      ),
    );

    const chat = Option.getOrThrow(await run(HobbotsRepository.use((repo) => repo.findThread(threadId))));
    const moved = await run(
      ChatService.use((service) =>
        service.moveChapter(threadId, chat.liveChapterId as ChapterId, {
          _tag: "new",
          key: CAMP,
          title: "The Skills explainer",
          goal: "Explain the Skills feature",
          private: false,
        }),
      ),
    );
    expect(moved.camp.id).toBe(CAMP);
    const inCamp = await run(TaskRepository.use((tasks) => tasks.readThreadTrees(CAMP)));
    expect(inCamp[0]?.tasks.map((task) => task.threadId)).toEqual([CAMP, CAMP]);
    expect(inCamp[0]?.quests.map((quest) => quest.threadId)).toEqual([CAMP]);
    // The camp's quest pill reads the quest at once; the chat's no longer has it.
    const summaries = await run(
      Effect.all([
        TaskRepository.use((tasks) => tasks.listQuestSummaries(CAMP)),
        TaskRepository.use((tasks) => tasks.listQuestSummaries(threadId)),
      ]),
    );
    expect(summaries[0].map((summary) => summary.threadId)).toEqual([CAMP]);
    expect(summaries[1]).toEqual([]);

    // Pip finishes: his result reaches Frodo in the camp, and Frodo's turn about it runs there.
    open();
    const campMessages = await run(
      waitUntil(
        HobbotsRepository.use((repo) => repo.listMessages(CAMP)),
        (all) => continuations(all).length > 0 && all.every((m) => m.status === "complete"),
        { what: "Frodo's turn in the camp" },
      ),
    );
    // Frodo's turn read Pip's result: its prompt is the continuation, and nothing landed in the chat.
    const last = requests.at(-1);
    expect(last?.prompt).toContain("(Write the Skills explainer) finished.");
    expect(continuations(campMessages)).toHaveLength(1);
    expect(await run(HobbotsRepository.use((repo) => repo.listMessages(threadId)))).toEqual([]);
    const [tree] = await run(TaskRepository.use((tasks) => tasks.readThreadTrees(CAMP)));
    expect(tree === undefined ? undefined : ownedBy(tree, PIP)?.state).toBe("completed");
  }, 30_000);
});
