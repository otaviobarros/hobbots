import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  AgentId,
  type MemberState,
  type SidebarSection,
  type SidebarThread,
  sidebarOf,
  sidebarSectionOf,
  Thread,
  ThreadId,
  ThreadMember,
  threadsNeedingYou,
} from "../src/index.ts";

// Issue #1469 (ADR 039, The sidebar): the hub sorts threads into Camps and Direct messages with one
// pure function over their members, and never stores which section a thread is in.

const you: Actor = { kind: "user", id: "owner" };
const marina: Actor = { kind: "user", id: "marina" };
const hob = (id: string): Actor => ({ kind: "hob", id });

const thread = (
  id: string,
  kind: "chat" | "camp",
  more: { agentId?: string; pinnedAt?: string | null; updatedAt?: string; state?: "open" | "archived" } = {},
): SidebarThread["thread"] => ({
  id: ThreadId.make(id),
  agentId: AgentId.make(more.agentId ?? "aldric"),
  kind,
  state: more.state ?? "open",
  pinnedAt: more.pinnedAt ?? null,
  updatedAt: more.updatedAt ?? "2026-11-14T10:00:00.000Z",
});

const member = (actor: Actor, state: MemberState = "active") => ({ actor, state });

const entry = (
  t: SidebarThread["thread"],
  members: ReadonlyArray<{ actor: Actor; state: MemberState }>,
  unread = 0,
): SidebarThread => ({ thread: t, members, unread, mentions: 0, needsYou: false });

describe("sidebarSectionOf", () => {
  it("puts a chat in Direct messages, a camp with one hob in its hob's camps, and a camp with more in shared camps (#1469)", () => {
    expect(sidebarSectionOf({ kind: "chat" }, [member(you), member(hob("aldric"))], you)).toBe("direct-message");
    expect(sidebarSectionOf({ kind: "camp" }, [member(you), member(hob("aldric"))], you)).toBe("hob-camp");
    expect(sidebarSectionOf({ kind: "camp" }, [member(you), member(hob("aldric")), member(hob("quill"))], you)).toBe(
      "shared-camp",
    );
    expect(sidebarSectionOf({ kind: "camp" }, [member(you), member(marina)], you)).toBe("shared-camp");
    // A hob that left no longer makes the camp shared.
    expect(
      sidebarSectionOf({ kind: "camp" }, [member(you), member(hob("aldric")), member(hob("quill"), "left")], you),
    ).toBe("hob-camp");
  });
});

describe("sidebarOf", () => {
  it("lists shared camps first, then the hobs' own camps pinned first, then by last activity (#1469)", () => {
    const sidebar = sidebarOf({
      you,
      threads: [
        entry(thread("chat-aldric", "chat"), [member(you), member(hob("aldric"))]),
        entry(thread("old", "camp", { updatedAt: "2026-11-14T08:00:00.000Z" }), [member(you), member(hob("aldric"))]),
        entry(thread("new", "camp", { updatedAt: "2026-11-14T09:00:00.000Z" }), [member(you), member(hob("aldric"))]),
        entry(
          thread("pinned", "camp", { pinnedAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }),
          [member(you), member(hob("aldric"))],
        ),
        entry(thread("team", "camp", { updatedAt: "2026-11-01T00:00:00.000Z" }), [
          member(you),
          member(hob("aldric")),
          member(hob("quill")),
        ]),
        entry(thread("chat-quill", "chat", { agentId: "quill" }), [member(you), member(hob("quill"))]),
        entry(thread("archived", "camp", { state: "archived" }), [member(you), member(hob("aldric"))]),
        entry(thread("left", "camp"), [member(you, "left"), member(hob("aldric"))]),
      ],
    });
    expect(sidebar.camps.map((place) => [place.threadId, place.section])).toEqual([
      ["team", "shared-camp"],
      ["pinned", "hob-camp"],
      ["new", "hob-camp"],
      ["old", "hob-camp"],
    ]);
    expect(sidebar.camps[0]?.others).toEqual([hob("aldric"), hob("quill")]);
    // Direct messages keep the hub's order, hob by hob.
    expect(sidebar.directMessages.map((place) => place.threadId)).toEqual(["chat-aldric", "chat-quill"]);
  });

  it("moves a camp between sections as its members change, with nothing on the thread to change (#1469)", () => {
    const camp = thread("camp", "camp");
    const alone = sidebarOf({ you, threads: [entry(camp, [member(you), member(hob("aldric"))], 2)] });
    const shared = sidebarOf({
      you,
      threads: [entry(camp, [member(you), member(hob("aldric")), member(hob("pip"))], 2)],
    });
    expect(alone.camps.map((place) => place.section)).toEqual(["hob-camp"]);
    expect(shared.camps.map((place) => place.section)).toEqual(["shared-camp"]);
    expect(shared.camps[0]?.unread).toBe(2);
    // The section is worked out on every read: neither a thread nor a member holds it.
    expect(Object.keys(Thread.fields)).not.toContain("section");
    expect(Object.keys(ThreadMember.fields)).not.toContain("section");
  });

  it("lists every open thread you are active in exactly once, in the section its members decide (#1469)", () => {
    const actor = fc.constantFrom(you, marina, hob("aldric"), hob("quill"), hob("pip"));
    const anEntry = fc.record({
      kind: fc.constantFrom("chat" as const, "camp" as const),
      state: fc.constantFrom("open" as const, "archived" as const),
      pinned: fc.boolean(),
      minute: fc.integer({ min: 0, max: 59 }),
      members: fc.uniqueArray(fc.record({ actor, state: fc.constantFrom<MemberState>("active", "left", "removed") }), {
        selector: (m) => `${m.actor.kind}:${m.actor.id}`,
        maxLength: 5,
      }),
    });
    fc.assert(
      fc.property(fc.array(anEntry, { maxLength: 12 }), (raw) => {
        const threads = raw.map((r, i) =>
          entry(
            thread(`t${i}`, r.kind, {
              state: r.state,
              pinnedAt: r.pinned ? `2026-11-14T00:${String(r.minute).padStart(2, "0")}:00.000Z` : null,
              updatedAt: `2026-11-14T10:${String(r.minute).padStart(2, "0")}:00.000Z`,
            }),
            r.members,
          ),
        );
        const sidebar = sidebarOf({ you, threads });
        const listed = [...sidebar.camps, ...sidebar.directMessages];
        const expected = threads.filter(
          (t) =>
            t.thread.state === "open" &&
            t.members.some((m) => m.state === "active" && m.actor.kind === "user" && m.actor.id === "owner"),
        );
        expect(listed.map((p) => p.threadId).sort()).toEqual(expected.map((t) => t.thread.id).sort());
        for (const place of listed) {
          const source = expected.find((t) => t.thread.id === place.threadId);
          if (source === undefined) throw new Error("listed a thread not given");
          expect(place.section).toBe(sidebarSectionOf(source.thread, source.members, you));
        }
        const order: ReadonlyArray<SidebarSection> = sidebar.camps.map((p) => p.section);
        expect(order).toEqual([...order].sort((a, b) => (a === b ? 0 : a === "shared-camp" ? -1 : 1)));
      }),
    );
  });
});

describe("threadsNeedingYou", () => {
  it("marks the threads where an approval, a question, a blocker or failed work waits on you (#1469)", () => {
    const asked = ThreadId.make("asked");
    const questioned = ThreadId.make("questioned");
    const blocked = ThreadId.make("blocked");
    const failed = ThreadId.make("failed");
    const decided = ThreadId.make("decided");
    const toLead = ThreadId.make("to-lead");
    const needing = threadsNeedingYou({
      approvals: [
        { threadId: asked, state: "pending" },
        { threadId: decided, state: "approved" },
      ],
      blockers: [{ threadId: blocked }, { threadId: null }],
      questions: [
        { question: { recipientId: null }, task: { threadId: questioned } },
        // A question still on its way up to a lead waits on the lead, not on you.
        { question: { recipientId: AgentId.make("aldric") }, task: { threadId: toLead } },
      ],
      failed: [{ task: { threadId: failed } }, { task: { threadId: null } }],
      decides: () => true,
    });
    expect([...needing].sort()).toEqual([asked, blocked, failed, questioned].sort());
  });

  it("marks a shared camp only for the person who decides there, not for the members waiting on them (#1469)", () => {
    const shared = ThreadId.make("shared");
    const input = {
      approvals: [{ threadId: shared, state: "pending" as const }],
      blockers: [],
      questions: [{ question: { recipientId: null }, task: { threadId: shared } }],
      failed: [],
    };
    expect([...threadsNeedingYou({ ...input, decides: () => true })]).toEqual([shared]);
    expect([...threadsNeedingYou({ ...input, decides: () => false })]).toEqual([]);
  });

  it("carries the mark onto the thread's place, and a reply waiting on commands does not set it (#1469)", () => {
    const camp = thread("camp", "camp");
    const sidebar = sidebarOf({
      you,
      threads: [{ ...entry(camp, [member(you), member(hob("aldric"))]), needsYou: true }],
    });
    expect(sidebar.camps.map((place) => place.needsYou)).toEqual([true]);
    const quiet = sidebarOf({ you, threads: [entry(camp, [member(you), member(hob("aldric"))])] });
    expect(quiet.camps.map((place) => place.needsYou)).toEqual([false]);
  });
});
