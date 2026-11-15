import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptRequest } from "@hobbots/agents";
import { CONTINUATION_HEADER, type TaskTree } from "@hobbots/domain";
import { FAKE_SAY_ANSWERS_DIRECTIVE } from "@hobbots/runtimes";
import { afterEach, describe, expect, it } from "vitest";
import { hub, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1560: the fake runtime's reply repeated each hub answer, ids included, and the context pack
// carries what a hob wrote. So a new fake session "knew" ids that only an earlier session's tool
// result held, which a real Claude Code or Codex session never sees again (#1555 passed that way).
// The fake now leaves the hub's answers out of its reply unless a prompt says `fake:say-answers`.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const isLeadsFirst = (request: PromptRequest) => request.prompt.startsWith("Write the launch page");
const isWake = (request: PromptRequest) => request.prompt.startsWith(CONTINUATION_HEADER);
const done = (tree: TaskTree) => tree.tasks[0]?.state === "completed";

/** What a new session reads of what came before: its briefing and prompt, without the Task part the hub writes from records. */
const carriedOver = (request: PromptRequest | undefined) => {
  const briefing = request?.briefing ?? "";
  const at = briefing.indexOf("You are working on Task");
  return `${at === -1 ? briefing : briefing.slice(0, at)}\n\n${request?.prompt ?? ""}`;
};

/** Runs a Quest whose lead's wake starts a new session, and gives back that wake and the Quest's id. */
const questWithNewSession = async (firstLines: ReadonlyArray<string>) => {
  // Frodo's first turn runs without stop_quest, so on Codex his wake starts a new thread (#1543).
  const party = partyHub({
    lead: "codex",
    members: "codex",
    files: true,
    withholds: (request) => (isLeadsFirst(request) ? ["stop_quest"] : []),
  });
  dispose = party.dispose;
  writeFileSync(join(party.project, "index.html"), "<h1>Launch on Friday 6 December</h1>\n");
  party.reactions.push({
    on: CONTINUATION_HEADER,
    lines: [hub("complete_task", { key: "whole", delivered: true, summary: "The page is written" })],
  });
  await party.run(
    send([
      "Write the launch page",
      ...firstLines,
      hub("start_quest", { key: "quest", goal: "Write the launch page", acceptance: ["The page names the date"] }),
      hub("delegate_task", {
        key: "page",
        hob: "Pip",
        brief: [
          "Write the launch page",
          hub("complete_task", {
            key: "pip-done",
            summary: "Written",
            artifacts: [{ kind: "file", label: "Launch page", value: "index.html" }],
          }),
        ].join("\n"),
      }),
      hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
    ]),
  );
  const finished = await party.run(treeWhen(done));
  const ids = finished.quests.map((quest) => quest.id as string);
  if (ids.length === 0) throw new Error("no Quest started");
  return { wake: party.requests.find(isWake), ids, answer: party.answers.get("quest") ?? "" };
};

describe("a new fake session", () => {
  // Issue #1560
  it("can't read an id that only an earlier session's tool result held (#1560)", async () => {
    const { wake, ids, answer } = await questWithNewSession([]);
    expect(wake?.sessionId).toBeNull();
    // The hub did answer the id; the new session just isn't told it again by the pack.
    for (const id of ids) {
      expect(answer).toContain(id);
      expect(carriedOver(wake)).not.toContain(id);
    }
  }, 30_000);

  // Issue #1560
  it("reads it once the earlier turn asks the fake to repeat the hub's answers (#1560)", async () => {
    // The guard above holds only because the fake stays quiet: repeating the answers leaks the id.
    const { wake, ids } = await questWithNewSession([FAKE_SAY_ANSWERS_DIRECTIVE]);
    expect(wake?.sessionId).toBeNull();
    for (const id of ids) expect(carriedOver(wake)).toContain(id);
  }, 30_000);
});
