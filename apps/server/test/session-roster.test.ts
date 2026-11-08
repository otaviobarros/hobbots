import { HobbotsRepository, type PromptRequest } from "@hobbots/agents";
import { Agent, AgentTransitions } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { hub, isLive, NETTLE, ownedBy, PIP, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// The roster of other hobs (ADR 032) in sessions that work a Task outside any chat: a party
// member's and a step's, and `read_hob` from a member's session.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const names = (request: PromptRequest | undefined) =>
  (request?.briefing ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.split(":")[0]);

describe("the roster outside chats", () => {
  // covers ADR 032 (The roster, read_hob), OR-004
  it("[TC-OR-1234-01] a member's and a step's sessions see the other hobs, never themselves, and a member reads a card", async () => {
    const party = partyHub({ directory: true });
    dispose = party.dispose;
    const { run, requests, answers } = party;
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the project",
            hub("read_hob", { key: "card", hob: "Nettle" }),
            hub("complete_task", { delivered: true, key: "done", summary: "Reviewed" }),
          ].join("\n"),
        }),
        hub("plan_steps", {
          key: "plan",
          steps: [
            {
              brief: [
                "Draft the notes",
                hub("complete_task", { delivered: true, key: "noted", summary: "Drafted" }),
              ].join("\n"),
            },
          ],
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    await run(treeWhen((each) => ownedBy(each, PIP)?.state === "completed"));
    const opening = (match: (request: PromptRequest) => boolean) =>
      requests.find((request) => request.sessionId === null && match(request));

    const member = opening((request) => request.prompt.startsWith("Review the project\nfake:hub read_hob"));
    expect(member?.briefing).toMatch(/^## Other hobs on this hub/);
    expect(names(member)).toEqual(['- "Frodo"', '- "Nettle"', '- "Quill"', '- "Rook"']);
    expect(member?.hubTools?.tools.map((tool) => tool.name)).toContain("read_hob");
    expect(answers.get("card")).toContain('### "Nettle"');

    const step = opening((request) => request.prompt.startsWith("Draft the notes\n"));
    expect(names(step)).toEqual(['- "Nettle"', '- "Pip"', '- "Quill"', '- "Rook"']);
  });

  // covers ADR 032 (The roster, Sent again only when it changed)
  it("[TC-OR-1234-02] a member's resumed session hears the roster again only when it changed", async () => {
    const party = partyHub({ directory: true });
    dispose = party.dispose;
    const { run, requests, gates } = party;
    const opens = new Map<string, () => void>();
    for (const key of ["second", "done"]) {
      const opened = new Promise<void>((resolve) => opens.set(key, resolve));
      gates.set(key, () => opened);
    }
    const finding = (key: string, summary: string) => hub("report_checkpoint", { key, kind: "finding", summary });
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the project",
            hub("delegate_task", {
              key: "lint",
              hob: "Nettle",
              brief: [
                "Lint the project",
                finding("first", "core.py has an unused import"),
                finding("second", "app.py has a long line"),
                hub("complete_task", { delivered: true, key: "done", summary: "Two lint findings" }),
              ].join("\n"),
            }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const started = await run(treeWhen((tree) => ownedBy(tree, PIP) !== undefined));
    const pip = ownedBy(started, PIP);
    if (pip === undefined) throw new Error("no Task for Pip");
    const pips = () => requests.filter((each) => each.tools?.runtimeFolder.endsWith(`/${PIP}`));
    const woken = async (count: number) => {
      await run(treeWhen(() => pips().length >= count + 1));
      await run(
        treeWhen(
          (tree) =>
            ownedBy(tree, NETTLE) !== undefined &&
            !tree.attempts.some((each) => each.taskId === pip.id && isLive(each.state)),
        ),
      );
      return pips()[count] as PromptRequest;
    };

    const first = await woken(0);
    expect(first.sessionId).toBeNull();
    expect(names(first)).toContain('- "Frodo"');

    // Unchanged: the resumed session is not told it again.
    const unchanged = await woken(1);
    expect(unchanged.sessionId).not.toBeNull();
    expect(unchanged.briefing ?? "").not.toContain("Other hobs");

    // Changed: Quill is paused, and the next turn is told the new roster.
    await run(
      HobbotsRepository.use((repo) =>
        Effect.gen(function* () {
          const quill = Option.getOrThrow(yield* repo.findAgent(QUILL));
          const paused = AgentTransitions.pause(quill);
          if (!(paused instanceof Agent)) throw paused;
          yield* repo.setAgentStatus(paused, "active");
        }),
      ),
    );
    opens.get("second")?.();
    const changed = await woken(2);
    expect(changed.sessionId).toBe(unchanged.sessionId);
    // Paused hobs come after the active ones.
    expect(names(changed)).toEqual(['- "Frodo"', '- "Nettle"', '- "Rook"', '- "Quill"']);
    expect(changed.briefing).toContain('- "Quill": "Engineer" with the Assistant sigil; paused;');
    opens.get("done")?.();
  }, 30_000);
});
