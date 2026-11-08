import { HobbotsRepository, type PromptRequest, splitRoster } from "@hobbots/agents";
import { Agent, type AgentId, MemoryPath } from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, NETTLE, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// Hobs see each other beside the work they do (ADR 032, #1235): a hidden hob still takes a Task you
// or a lead send it by name, and no roster or card gives away another hob's memory, Tasks or
// instructions, with a party of hobs that work Tasks on the fake runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

type Party = ReturnType<typeof partyHub>;

/** Saves `change` as the hob's next configuration version, as an edit in the profile does. */
const edit = (party: Party, id: AgentId, change: Partial<Agent>) =>
  party.run(
    HobbotsRepository.use((repo) =>
      Effect.gen(function* () {
        const current = Option.getOrThrow(yield* repo.findAgent(id));
        const saved = yield* repo.updateAgentConfig(
          new Agent({ ...current, ...change, configVersion: current.configVersion + 1 }),
        );
        if (Option.isNone(saved)) throw new Error(`${id} was not saved`);
      }),
    ),
  );

const names = (request: PromptRequest | undefined) =>
  (request?.briefing ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.split(":")[0]);

/** Frodo's opening request for the prompt that starts with `first`. */
const frodoAsked = (requests: ReadonlyArray<PromptRequest>, first: string) =>
  requests.find((request) => request.tools?.runtimeFolder.endsWith(`/${FRODO}`) && request.prompt.startsWith(first));

describe("the directory beside Tasks", () => {
  // covers ADR 032 (Visible to other hobs: Delegation by name still works), ADR 018
  it("[TC-OR-1235-01] a hidden hob is in no roster and unknown to read_hob, yet takes a Task delegated to it by name", async () => {
    const party = partyHub({ directory: true });
    dispose = party.dispose;
    const { run, requests, answers } = party;
    await edit(party, NETTLE, { visibleToHobs: false });
    await run(
      send([
        "Lint the project",
        hub("read_hob", { key: "card", hob: "Nettle" }),
        hub("delegate_task", {
          key: "lint",
          hob: "Nettle",
          brief: ["Lint the project", hub("complete_task", { delivered: true, key: "done", summary: "Linted" })].join(
            "\n",
          ),
        }),
        hub("wait_for", { key: "wait", tasks: ["$lint.task_id"] }),
      ]),
    );
    const tree = await run(treeWhen((each) => ownedBy(each, NETTLE)?.state === "completed"));
    expect(ownedBy(tree, NETTLE)?.brief).toContain("Lint the project");
    expect(names(frodoAsked(requests, "Lint the project"))).toEqual(['- "Pip"', '- "Quill"', '- "Rook"']);
    expect(answers.get("card")).toContain("There is no hob named Nettle.");
    // Nettle, hidden, still sees the others in its own session.
    const nettle = requests.find((request) => request.tools?.runtimeFolder.endsWith(`/${NETTLE}`));
    expect(names(nettle)).toEqual(['- "Frodo"', '- "Pip"', '- "Quill"', '- "Rook"']);
  }, 30_000);

  // covers ADR 032 (The public card: Never on the card)
  it("[TC-OR-1235-02] no roster or card gives away another hob's memory, Tasks or instructions", async () => {
    const memory = makeMemoryStoreFake();
    await Effect.runPromise(
      memory.store.write(
        { _tag: "You" },
        { _tag: "Hob", agentId: PIP },
        {
          path: MemoryPath.make("notes/keys.md"),
          markdown: "# Keys\n\nPip keeps the Bluebird keys.",
          tags: [],
          pinned: false,
        },
        { _tag: "Any" },
      ),
    );
    const party = partyHub({ directory: true, memory: memory.store });
    dispose = party.dispose;
    const { run, requests, answers } = party;
    await edit(party, PIP, { instructions: "Pip's private plan: ship Bluebird in March.", goodAt: "Launch emails." });
    await run(
      send([
        "Plan the launch",
        hub("delegate_task", {
          key: "launch",
          hob: "Pip",
          brief: [
            "Draft the Bluebird launch email",
            hub("complete_task", { delivered: true, key: "done", summary: "Drafted the Bluebird email" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$launch.task_id"] }),
      ]),
    );
    await run(treeWhen((each) => ownedBy(each, PIP)?.state === "completed"));
    // With Pip's memory, a Task and its result on the hub, another hob's roster and card of Pip.
    await run(
      send(["Who is Pip?", hub("read_hob", { key: "card", hob: "Pip" }), hub("read_hob", { key: "id", hob: PIP })]),
    );
    await run(treeWhen(() => answers.has("id")));
    // Every roster another hob was told, and both cards: Frodo's own briefing may report his Task's
    // result, as a lead's does, but nothing the directory hands over may.
    const rosters = requests
      .filter((request) => !request.tools?.runtimeFolder.endsWith(`/${PIP}`))
      .map((request) => splitRoster(request.briefing ?? "").roster ?? "");
    expect(rosters.filter((roster) => roster.includes('- "Pip"')).length).toBeGreaterThan(0);
    const told = [...rosters, answers.get("card") ?? "", answers.get("id") ?? ""].join("\n");
    expect(answers.get("card")).toContain('- Good at: "Launch emails."');
    expect(answers.get("id")).toContain('### "Pip"');
    for (const kept of ["Bluebird", "private plan", "keys", "Drafted", "launch email"]) {
      expect(told, kept).not.toContain(kept);
    }
  }, 30_000);
});
