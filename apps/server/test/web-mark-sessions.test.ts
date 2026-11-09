import { HobbotsRepository } from "@hobbots/agents";
import { Agent } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { hub, isLive, NETTLE, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// The read-the-web mark of a session that works a Task outside any chat (ADR 036): each Attempt
// that runs in a marked session records the mark, from its start.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("the read-the-web mark of a member's session", () => {
  // covers ADR 036 (The read-the-web mark)
  it("[TC-PE-1268-08] a member's new Attempt that resumes a session which read the web records the mark from its start", async () => {
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
            "fake:search lamp oil",
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
    const woken = (count: number) =>
      run(
        treeWhen(
          (tree) =>
            pips().length >= count + 1 &&
            ownedBy(tree, NETTLE) !== undefined &&
            !tree.attempts.some((each) => each.taskId === pip.id && isLive(each.state)),
        ),
      );
    await woken(0);
    // Pip's instructions change, so its next turn starts a new Attempt, in the session it had.
    await run(
      HobbotsRepository.use((repo) =>
        Effect.gen(function* () {
          const current = Option.getOrThrow(yield* repo.findAgent(PIP));
          yield* repo.updateAgentConfig(
            new Agent({ ...current, instructions: "Review with care.", configVersion: current.configVersion + 1 }),
          );
        }),
      ),
    );
    opens.get("second")?.();
    const tree = await woken(1);
    const resumed = pips()[1];
    expect(resumed?.sessionId).not.toBeNull();
    expect(resumed?.prompt).not.toContain("fake:search");
    expect(resumed?.briefing).toContain("This session has read the web.");
    const inSession = tree.attempts.filter((each) => each.taskId === pip.id && each.sessionId === resumed?.sessionId);
    expect(inSession.length).toBeGreaterThan(1);
    for (const attempt of inSession) expect(attempt.readWeb).toMatchObject({ source: 'the web search "lamp oil"' });
    opens.get("done")?.();
  }, 30_000);
});
