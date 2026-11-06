import type { PromptRequest } from "@hobbots/agents";
import { waitUntil } from "@hobbots/domain/testing";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { hub, partyHub, send } from "./party-hub.ts";

// Issue #1027: a lead's chat resumes the same session on every wake, yet each wake told it the whole
// Quest again, every result so far included. A wake on the session that was told before is now
// told only what changed since, so its prompts stay bounded as members finish.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** How a briefing of only what changed starts. */
const SINCE_LAST_TURN = "Only what changed since your last turn is listed below";

const MEMBERS = ["Quill", "Rook", "Pip", "Nettle"] as const;

/** Each member's Task, after the one before it, so each finish wakes the lead on its own. */
const delegated = MEMBERS.map((hob, index) =>
  hub("delegate_task", {
    key: hob,
    hob,
    ...(index === 0 ? {} : { depends_on: [["$", MEMBERS[index - 1], ".task_id"].join("")] }),
    brief: [`Work for ${hob}`, hub("complete_task", { key: `${hob}-done`, summary: `${hob} finished its part` })].join(
      "\n",
    ),
  }),
);

/** The briefings the lead's turns on its Task were told, oldest first. */
const leadBriefings = (all: ReadonlyArray<PromptRequest>) =>
  all.map((each) => each.briefing ?? "").filter((briefing) => briefing.includes("for this conversation:"));

describe("a lead's briefing over a Quest", () => {
  // covers OR-004, OR-005
  it("[TC-OR-603] a lead woken as each member finishes is told each result once, and all of it when you write", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests } = party;
    await run(send(["Ship the launch", ...delegated]));
    const briefings = await run(
      waitUntil(
        Effect.sync(() => leadBriefings(requests)),
        (all) => all.some((briefing) => briefing.includes("Nettle finished its part")),
        { what: "the lead's wake on the last result" },
      ),
    );
    // The turn that started the Task was told nothing of it, so its first wake is told it all.
    const [whole, ...later] = briefings;
    expect(whole).not.toContain(SINCE_LAST_TURN);
    expect(later.length).toBeGreaterThan(0);
    for (const briefing of later) expect(briefing).toContain(SINCE_LAST_TURN);
    // Its rules too: the wakes on the session that holds them are not told them again (#1039).
    expect(whole).toContain("Tell the user only what your Task tools did");
    for (const briefing of later) expect(briefing).not.toContain("Tell the user only what your Task tools did");
    // Each result reaches the lead's briefings once, whichever wake carries it.
    for (const hob of MEMBERS) {
      expect(briefings.filter((briefing) => briefing.includes(`${hob} finished its part`))).toHaveLength(1);
    }
    // A turn that answers your message is told it all, every result included.
    await run(send(["How is it going?"]));
    const answering = await run(
      waitUntil(
        Effect.sync(() => requests.find((each) => each.prompt.startsWith("How is it going?"))),
        (found) => found !== undefined,
        { what: "the lead's turn on your message" },
      ),
    );
    expect(answering?.briefing).not.toContain(SINCE_LAST_TURN);
    expect(answering?.briefing).toContain("Tell the user only what your Task tools did");
    for (const hob of MEMBERS) expect(answering?.briefing).toContain(`${hob} finished its part`);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-604] a lead whose session was compacted is told the whole Quest on its next wake", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests } = party;
    // The runtime compacts the lead's session in its first wake, the turn after this one.
    await run(send(["Ship the launch", ...delegated, "fake:then fake:compact"]));
    const lead = () =>
      requests.filter((each) => (each.briefing ?? "").includes("for this conversation:") && each.sessionId !== null);
    const turns = await run(
      waitUntil(Effect.sync(lead), (all) => all.length >= 2, { what: "the lead's wake after the compaction" }),
    );
    const [compacted, next] = turns;
    // The compacted wake was briefed as a resumed one; the session holds a summary of it after.
    expect(compacted?.briefing).not.toContain(SINCE_LAST_TURN);
    // It holds a summary, not what it was told: the next wake is told the whole Quest again.
    expect(next?.sessionId).toBe(compacted?.sessionId);
    expect(next?.briefing).not.toContain(SINCE_LAST_TURN);
    expect(next?.briefing).toContain("Quill finished its part");
    expect(next?.briefing).toContain("Tell the user only what your Task tools did");
  }, 30_000);
});
