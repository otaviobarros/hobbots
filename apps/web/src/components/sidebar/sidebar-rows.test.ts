import { Agent, AgentId, SidebarPlace, Channel, ChannelId, User, UserId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { authorName, campRows, directRows, rowTime, unreadCount } from "./sidebar-rows.ts";

// Issue #1469 (ADR 039, The sidebar): rows join the hub's sections with the live channels and hobs.

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
const channel = (id: string, agentId: string, kind: "direct" | "camp") =>
  new Channel({
    id: ChannelId.make(id),
    agentId: AgentId.make(agentId),
    title: id,
    kind,
    createdAt: NOW,
    updatedAt: NOW,
  });
const place = (
  channelId: string,
  agentId: string,
  section: SidebarPlace["section"],
  others: SidebarPlace["others"],
  unread = 0,
  needsYou = false,
) =>
  new SidebarPlace({
    channelId: ChannelId.make(channelId),
    agentId: AgentId.make(agentId),
    section,
    others,
    unread,
    mentions: 0,
    needsYou,
  });
const marina = new User({ id: UserId.make("marina"), name: "Marina", initials: "MR", color: "rose", state: "active" });

describe("sidebar rows", () => {
  it("joins each camp with its channel, hob, faces and needs-you mark, and waits for a channel not loaded yet (#1469)", () => {
    const aldric = hob("aldric");
    const quill = hob("quill");
    const team = channel("team", "aldric", "camp");
    const channels = new Map([[team.id, team]]);
    const rows = campRows({
      places: [
        place(
          "team",
          "aldric",
          "shared-camp",
          [
            { kind: "hob", id: "aldric" },
            { kind: "user", id: "marina" },
            { kind: "hob", id: "quill" },
          ],
          0,
          true,
        ),
        place("later", "aldric", "hob-camp", [{ kind: "hob", id: "aldric" }]),
      ],
      channels,
      hobs: [aldric, quill],
      you: undefined,
      people: [marina],
      unread: undefined,
    });
    expect(rows.map((row) => row.channel.id)).toEqual(["team"]);
    expect(rows[0]?.faces).toEqual([
      { _tag: "hob", hob: aldric },
      { _tag: "person", person: marina },
    ]);
    expect(rows[0]?.needs).toBe(true);
  });

  it("names who wrote a camp's last line: You, a hob or a person, and nobody it does not know (#1563)", () => {
    const you = new User({ id: UserId.make("owner"), name: "Otavio", initials: "OB", color: "amber", state: "active" });
    const known = { you, hobs: [hob("aldric")], people: [marina] };
    expect(authorName({ ...known, author: { kind: "user", id: "owner" } })).toBe("You");
    expect(authorName({ ...known, author: { kind: "user", id: "marina" } })).toBe("Marina");
    expect(authorName({ ...known, author: { kind: "hob", id: "aldric" } })).toBe("aldric");
    expect(authorName({ ...known, author: { kind: "user", id: "leo" } })).toBeNull();
    expect(authorName({ ...known, author: { kind: "hub", id: "hub" } })).toBeNull();
    expect(authorName({ ...known, author: null })).toBeNull();
  });

  it("gives a camp's row the name of who wrote its last line (#1563)", () => {
    const team = new Channel({
      ...channel("team", "aldric", "camp"),
      lastLine: "one caption idea each?",
      lastAuthor: { kind: "user", id: "marina" },
    });
    const [row] = campRows({
      places: [place("team", "aldric", "shared-camp", [{ kind: "user", id: "marina" }])],
      channels: new Map([[team.id, team]]),
      hobs: [hob("aldric")],
      you: undefined,
      people: [marina],
      unread: undefined,
    });
    expect(row?.lastAuthor).toBe("Marina");
  });

  it("lists every hob in its order, each with its direct message once the hub lists one (#1469)", () => {
    const chat = channel("chat-quill", "quill", "direct");
    const rows = directRows({
      hobs: [hob("aldric"), hob("quill")],
      places: [place("chat-quill", "quill", "direct-message", [{ kind: "hob", id: "quill" }])],
      channels: new Map([[chat.id, chat]]),
    });
    expect(rows.map((row) => [row.hob.id, row.chat?.id])).toEqual([
      ["aldric", undefined],
      ["quill", "chat-quill"],
    ]);
  });

  it("counts the hub's unread replies, kept in step with the live unread channels (#1469)", () => {
    const counted = place("c", "aldric", "hob-camp", [], 3);
    expect(unreadCount(counted, undefined)).toBe(3);
    expect(unreadCount(counted, new Set())).toBe(0);
    expect(unreadCount(place("c", "aldric", "hob-camp", [], 0), new Set([ChannelId.make("c")]))).toBe(1);
  });

  it("shows today's time of day, and the day for an older row (#1469)", () => {
    const now = new Date("2026-11-14T15:00:00");
    expect(rowTime(new Date("2026-11-14T09:05:00").toISOString(), now, "en-US")).toBe("9:05 AM");
    expect(rowTime(new Date("2026-11-12T09:05:00").toISOString(), now, "en-US")).toBe("Nov 12");
  });
});
