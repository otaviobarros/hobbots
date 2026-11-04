import { AgentId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { allArchivedChats, isArchiveTab, scopeHobs, visibleChats } from "./archive-model.ts";

const pip = { id: AgentId.make("pip"), name: "Pip" };
const moss = { id: AgentId.make("moss"), name: "Moss" };
const ada = { id: AgentId.make("ada"), name: "Ada" };

const thread = (id: string, title: string, archivedAt: string) => ({ id: ThreadId.make(id), title, archivedAt });

const newsletter = thread("t-news", "Rename the newsletter", "2026-10-02T10:00:00.000Z");
const offsite = thread("t-off", "Team offsite ideas", "2026-09-02T10:00:00.000Z");
const pricing = thread("t-price", "Café pricing, summer", "2026-10-20T10:00:00.000Z");

const chats = allArchivedChats(
  [pip, moss, ada],
  new Map([
    [pip.id, [newsletter, offsite]],
    [moss.id, [pricing]],
  ]),
);

describe("allArchivedChats", () => {
  it("joins every hob's archived chats, most recently archived first", () => {
    expect(chats.map((chat) => [chat.hob.name, chat.thread.id])).toEqual([
      ["Moss", "t-price"],
      ["Pip", "t-news"],
      ["Pip", "t-off"],
    ]);
  });
});

describe("scopeHobs", () => {
  it("offers the hobs with archived chats by name, and the chosen hob even without any", () => {
    expect(scopeHobs([pip, moss, ada], chats, undefined).map((hob) => hob.name)).toEqual(["Moss", "Pip"]);
    expect(scopeHobs([pip, moss, ada], chats, ada.id).map((hob) => hob.name)).toEqual(["Ada", "Moss", "Pip"]);
  });
});

describe("visibleChats", () => {
  const none = new Set<ThreadId>();

  it("keeps one hob's chats, or every hob's", () => {
    expect(visibleChats(chats, pip.id, "", none).map((chat) => chat.thread.id)).toEqual(["t-news", "t-off"]);
    expect(visibleChats(chats, undefined, "", none)).toHaveLength(3);
  });

  it("matches every word of the query in the title, ignoring case and accents", () => {
    expect(visibleChats(chats, undefined, "cafe SUMMER", none).map((chat) => chat.thread.id)).toEqual(["t-price"]);
    expect(visibleChats(chats, undefined, "cafe newsletter", none)).toEqual([]);
  });

  it("keeps a chat the hub's search found in its messages", () => {
    const hits = new Set([offsite.id]);
    expect(visibleChats(chats, undefined, "lisbon", hits).map((chat) => chat.thread.id)).toEqual(["t-off"]);
    expect(visibleChats(chats, moss.id, "lisbon", hits)).toEqual([]);
  });
});

describe("isArchiveTab", () => {
  it("knows the two tabs", () => {
    expect(isArchiveTab("chats")).toBe(true);
    expect(isArchiveTab("hobs")).toBe(true);
    expect(isArchiveTab("history")).toBe(false);
  });
});
