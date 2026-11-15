import { AgentId, Sidebar, SidebarPlace, ThreadId, UserId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { namedPeople } from "../src/sidebar.ts";

// Issue #1563 (ADR 039, The sidebar): a shared camp's row names who wrote its last line, so the
// sidebar's read lists that person even once they have left the camp.

const place = (threadId: string, section: SidebarPlace["section"], others: SidebarPlace["others"]) =>
  new SidebarPlace({
    threadId: ThreadId.make(threadId),
    agentId: AgentId.make("aldric"),
    section,
    others,
    unread: 0,
    mentions: 0,
    needsYou: false,
  });

describe("namedPeople", () => {
  it("names every row's members and each camp's last-line author, never a hob (#1563)", () => {
    const sidebar = new Sidebar({
      camps: [
        place("team", "shared-camp", [
          { kind: "user", id: "bruna" },
          { kind: "hob", id: "aldric" },
        ]),
      ],
      directMessages: [place("chat", "direct-message", [{ kind: "hob", id: "aldric" }])],
    });
    const named = namedPeople(sidebar, [
      { id: ThreadId.make("team"), lastAuthor: { kind: "user", id: "leo" } },
      { id: ThreadId.make("chat"), lastAuthor: { kind: "user", id: "marina" } },
      { id: ThreadId.make("gone"), lastAuthor: { kind: "user", id: "rui" } },
    ]);
    expect([...named].sort()).toEqual([UserId.make("bruna"), UserId.make("leo")]);
  });
});
