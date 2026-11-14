import { Agent, AgentId, SidebarPlace, Thread, ThreadId, User, UserId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { campRows, directRows, rowTime, unreadCount } from "./sidebar-rows.ts";

// Issue #1469 (ADR 039, The sidebar): rows join the hub's sections with the live threads and hobs.

const NOW = "2026-11-14T10:00:00.000Z";
const hob = (id: string) =>
  new Agent({
    id: AgentId.make(id),
    name: id,
    roleTitle: "Guide",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });
const thread = (id: string, agentId: string, kind: "chat" | "camp") =>
  new Thread({
    id: ThreadId.make(id),
    agentId: AgentId.make(agentId),
    title: id,
    kind,
    createdAt: NOW,
    updatedAt: NOW,
  });
const place = (
  threadId: string,
  agentId: string,
  section: SidebarPlace["section"],
  others: SidebarPlace["others"],
  unread = 0,
) =>
  new SidebarPlace({
    threadId: ThreadId.make(threadId),
    agentId: AgentId.make(agentId),
    section,
    others,
    unread,
    mentions: 0,
  });
const marina = new User({ id: UserId.make("marina"), name: "Marina", initials: "MR", color: "rose", state: "active" });

describe("sidebar rows", () => {
  it("[TC-UX-1469-04] joins each camp with its thread, hob and faces, and waits for a thread not loaded yet", () => {
    const aldric = hob("aldric");
    const quill = hob("quill");
    const team = thread("team", "aldric", "camp");
    const threads = new Map([[team.id, team]]);
    const rows = campRows({
      places: [
        place("team", "aldric", "shared-camp", [
          { kind: "hob", id: "aldric" },
          { kind: "user", id: "marina" },
          { kind: "hob", id: "quill" },
        ]),
        place("later", "aldric", "hob-camp", [{ kind: "hob", id: "aldric" }]),
      ],
      threads,
      hobs: [aldric, quill],
      people: [marina],
      replies: { [ThreadId.make("team")]: "waiting" },
      unread: undefined,
    });
    expect(rows.map((row) => row.thread.id)).toEqual(["team"]);
    expect(rows[0]?.faces).toEqual([
      { _tag: "hob", hob: aldric },
      { _tag: "person", person: marina },
    ]);
    expect(rows[0]?.needs).toBe(true);
  });

  it("[TC-UX-1469-05] lists every hob in its order, each with its direct message once the hub lists one", () => {
    const chat = thread("chat-quill", "quill", "chat");
    const rows = directRows({
      hobs: [hob("aldric"), hob("quill")],
      places: [place("chat-quill", "quill", "direct-message", [{ kind: "hob", id: "quill" }])],
      threads: new Map([[chat.id, chat]]),
    });
    expect(rows.map((row) => [row.hob.id, row.chat?.id])).toEqual([
      ["aldric", undefined],
      ["quill", "chat-quill"],
    ]);
  });

  it("[TC-UX-1469-06] counts the hub's unread replies, kept in step with the live unread threads", () => {
    const counted = place("c", "aldric", "hob-camp", [], 3);
    expect(unreadCount(counted, undefined)).toBe(3);
    expect(unreadCount(counted, new Set())).toBe(0);
    expect(unreadCount(place("c", "aldric", "hob-camp", [], 0), new Set([ThreadId.make("c")]))).toBe(1);
  });

  it("[TC-UX-1469-07] shows today's time of day, and the day for an older row", () => {
    const now = new Date("2026-11-14T15:00:00");
    expect(rowTime(new Date("2026-11-14T09:05:00").toISOString(), now, "en-US")).toBe("9:05 AM");
    expect(rowTime(new Date("2026-11-12T09:05:00").toISOString(), now, "en-US")).toBe("Nov 12");
  });
});
