import { Agent, AgentId, MemoryPath, MessageId, type PackRead, roleFields, User, UserId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { readFirstChips, requesterName } from "./work-quest-model.ts";

// Issue #1487 (ADR 039, Asking for a delivery in a shared camp): a Quest's card names who asked for
// it beside who runs it, and lists what its owner read first, each chip opening where it lives.

const NOW = "2026-11-16T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const PIP = AgentId.make("pip");

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    ...roleFields("writer"),
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });

const hobs = new Map([
  [ALDRIC, hob(ALDRIC, "Aldric")],
  [PIP, hob(PIP, "Pip")],
]);
const person = (id: string, name: string) =>
  new User({ id: UserId.make(id), name, initials: name.slice(0, 1), color: "moss", state: "active" });
const you = person("owner", "Marina");
const bruna = person("bruna", "Bruna");

describe("readFirstChips", () => {
  it("names each record the pack carried and opens it where it lives, in the pack's order", () => {
    const read: ReadonlyArray<PackRead> = [
      {
        _tag: "MemoryPage",
        scope: { _tag: "Hob", agentId: ALDRIC },
        path: MemoryPath.make("shop/look.md"),
        title: "The shop's look",
      },
      { _tag: "MemoryPage", scope: { _tag: "Everyone" }, path: MemoryPath.make("rules/tone.md"), title: "Tone" },
      { _tag: "Decision", id: "d1", title: "Sign-ups stop at 200", messageId: MessageId.make("m1") },
      { _tag: "Artifact", id: "a1", kind: "page", title: "Landing page", version: 3, messageId: null },
      { _tag: "Chapter", number: 2, title: "Market", messageId: MessageId.make("m4") },
      { _tag: "Chapter", number: 1, title: null, messageId: null },
    ];
    expect(
      readFirstChips(read, hobs, new Set([MessageId.make("m1"), MessageId.make("m4")])).map(({ label, opens }) => [
        label,
        opens,
      ]),
    ).toEqual([
      [
        "Aldric's memory: The shop's look",
        { _tag: "Memory", search: { scope: `hob:${ALDRIC}`, page: "shop/look.md" } },
      ],
      ["About you: Tone", { _tag: "Memory", search: { scope: "everyone", page: "rules/tone.md" } }],
      ["Decision: Sign-ups stop at 200", { _tag: "Message", messageId: "m1" }],
      // Made by a Task's work, so it has no message to open at.
      ["Landing page v3", null],
      ["Chapter 2: Market", { _tag: "Message", messageId: "m4" }],
      ["Chapter 1", null],
    ]);
  });

  it("lists nothing when no pack is known", () => {
    expect(readFirstChips([], hobs, new Set())).toEqual([]);
  });

  it("opens a decision or chapter only while its message is in the transcript shown, not once it moved away", () => {
    const read: ReadonlyArray<PackRead> = [
      { _tag: "Decision", id: "d1", title: "Sign-ups stop at 200", messageId: MessageId.make("moved") },
    ];
    expect(readFirstChips(read, hobs, new Set([MessageId.make("m1")]))[0]?.opens).toBeNull();
  });
});

describe("requesterName", () => {
  const name = (requestedBy: { kind: "user" | "hob" | "hub"; id: string }) =>
    requesterName({ requestedBy, owner: ALDRIC, you, people: [you, bruna], hobs });

  it("says you, a person's name or another hob's, and nothing when the owner started it on its own", () => {
    expect(name({ kind: "user", id: "owner" })).toBe("you");
    expect(name({ kind: "user", id: "bruna" })).toBe("Bruna");
    expect(name({ kind: "hob", id: PIP })).toBe("Pip");
    expect(name({ kind: "hob", id: ALDRIC })).toBeNull();
    // Never an id: someone this client does not know, or the hub, is not named.
    expect(name({ kind: "user", id: "stranger" })).toBeNull();
    expect(name({ kind: "hub", id: "hub" })).toBeNull();
  });
});
