import { AgentId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { allArchivedChats, isArchiveTab, scopeChips, visibleChats } from "./archive-model.ts";

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

describe("scopeChips", () => {
  const names = (list: ReadonlyArray<{ hob: { name: string }; count: number }>) =>
    list.map((chip) => `${chip.hob.name} ${chip.count}`);

  it("offers the hobs with archived chats, most chats first, and the chosen hob even without any", () => {
    expect(names(scopeChips([pip, moss, ada], chats, undefined).chips)).toEqual(["Pip 2", "Moss 1"]);
    expect(names(scopeChips([pip, moss, ada], chats, ada.id).chips)).toEqual(["Pip 2", "Moss 1", "Ada 0"]);
  });

  it("puts the hobs past six under More hobs by name, and shows a hob picked from there", () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ id: AgentId.make(`h${n}`), name: `Hob ${9 - n}` }));
    const lots = allArchivedChats(
      many,
      new Map(
        many.map((hob, n) => [
          hob.id,
          Array.from({ length: 9 - n }, (_, k) => thread(`${hob.id}-${k}`, "Chat", "2026-10-01T10:00:00.000Z")),
        ]),
      ),
    );
    const open = scopeChips(many, lots, undefined);
    expect(names(open.chips)).toEqual(["Hob 9 9", "Hob 8 8", "Hob 7 7", "Hob 6 6", "Hob 5 5", "Hob 4 4"]);
    expect(names(open.more)).toEqual(["Hob 1 1", "Hob 2 2", "Hob 3 3"]);
    const picked = scopeChips(many, lots, AgentId.make("h7"));
    expect(names(picked.chips).at(-1)).toBe("Hob 2 2");
    expect(names(picked.more)).toEqual(["Hob 1 1", "Hob 3 3"]);
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
