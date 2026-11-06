import { HobbotsRepository } from "@hobbots/agents";
import { usageTokens } from "@hobbots/domain";
import { UsageLedger } from "@hobbots/persistence";
import { afterEach, describe, expect, it } from "vitest";
import {
  FRODO,
  hub,
  isLive,
  messagesWhen,
  NETTLE,
  ownedBy,
  PIP,
  partyHub,
  send,
  threadId,
  treeWhen,
} from "./party-hub.ts";

// Issue #1011: a party member's Task runs in a session of its own and writes no reply, so Usage
// showed only the lead's chat replies, as if the lead had spent the whole Quest.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const period = { since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z" };

describe("what a party spends", () => {
  // regression for #1011
  // covers OP-002
  it("[TC-OP-108] counts each member's turns under that member, and the whole party for the Quest", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run } = party;
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the project",
            hub("delegate_task", { key: "lint", hob: "Nettle", brief: "Lint the project" }),
            hub("wait_for", { key: "wait", tasks: ["$lint.task_id"] }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const done = await run(
      treeWhen(
        (tree) =>
          ownedBy(tree, PIP)?.state === "completed" &&
          ownedBy(tree, NETTLE)?.state === "completed" &&
          !tree.attempts.some((each) => isLive(each.state)),
      ),
    );
    await run(messagesWhen(() => true));
    const { hobs, quests } = await run(UsageLedger.use((ledger) => ledger.usage(period.since, period.until)));

    // Pip and Nettle each spent their own turns, under their own names, on the fake runtime.
    const spent = (hobId: string) => hobs.filter((row) => row.hobId === hobId);
    for (const member of [PIP, NETTLE]) {
      const [row, ...others] = spent(member);
      expect(others).toEqual([]);
      expect(row).toMatchObject({ runtime: "claude-code", unreported: 0 });
      expect(row?.replies).toBeGreaterThan(0);
      expect(row === undefined ? 0 : usageTokens(row)).toBeGreaterThan(0);
    }
    // Frodo's own row counts only his chat replies.
    const replies = await run(HobbotsRepository.use((repo) => repo.listMessages(threadId)));
    const frodoReplies = replies.filter((m) => m.role === "assistant").length;
    expect(spent(FRODO).reduce((sum, row) => sum + row.replies, 0)).toBe(frodoReplies);

    // The Quest's total is its whole party's: Frodo's replies while it ran and every member's turn.
    const quest = done.quests.find((each) => each.parentQuestId === null);
    const questRow = quests.find((row) => row.questId === quest?.id);
    const all = hobs.reduce((sum, row) => sum + usageTokens(row), 0);
    const outside = quests.find((row) => row.questId === null)?.tokens ?? 0;
    expect(questRow?.party).toBe(3);
    expect(questRow?.tokens).toBe(all - outside);
    const members = [...spent(PIP), ...spent(NETTLE)].reduce((sum, row) => sum + usageTokens(row), 0);
    expect(questRow?.tokens).toBeGreaterThanOrEqual(members);
  }, 30_000);
});
