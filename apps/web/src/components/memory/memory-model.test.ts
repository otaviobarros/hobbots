import type { MemoryOverview } from "@hobbots/api";
import {
  Agent,
  AgentId,
  type MemoryChange,
  type MemoryPageSummary,
  MemoryPath,
  MemoryProjectIdentity,
  type MemoryScope,
  MemoryVersion,
} from "@hobbots/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import { retryUnlessRefused } from "../../api/live.ts";
import { withChanges } from "../../api/memory.ts";
import {
  changesByDay,
  filterChanges,
  type HobDirectory,
  headLine,
  historyRows,
  hitParts,
  kindChips,
  kindGroups,
  type MemoryView,
  memorySearchOf,
  memoryViewOf,
  recentlyLearned,
  scopeNav,
  searchScopes,
  shownLines,
} from "./memory-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

const hob = (id: string, name: string) =>
  new Agent({
    id: AgentId.make(id),
    name,
    roleTitle: "Writer",
    runtime: "claude-code",
    model: null,
    effort: "medium",
    instructions: "",
    lookSeed: 1,
    lookColor: "violet",
    configVersion: 1,
    createdAt: "2026-10-02T09:00:00.000Z",
  });

const pip = hob("0d6e2f0a-0000-4000-8000-000000000011", "Pip");
const ada = hob("0d6e2f0a-0000-4000-8000-000000000012", "Ada");
const gone = AgentId.make("0d6e2f0a-0000-4000-8000-000000000013");
const hobs: HobDirectory = new Map([
  [pip.id, pip],
  [ada.id, ada],
]);

const pipsOwn: MemoryScope = { _tag: "Hob", agentId: pip.id };
const formerOwn: MemoryScope = { _tag: "Hob", agentId: gone };
const everyone: MemoryScope = { _tag: "Everyone" };
const site: MemoryScope = { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/me/site") };
const docs: MemoryScope = { _tag: "Project", identity: MemoryProjectIdentity.make("docs") };

const path = (value: string) => MemoryPath.make(value);
const version = (value: string) => MemoryVersion.make(value);

const summary = (value: string, scope: MemoryScope = pipsOwn): MemoryPageSummary => ({
  scope,
  path: path(value),
  title: value,
  pinned: false,
  updatedAt: "2026-11-05T09:00:00.000Z",
});

const change = (at: string, author: MemoryChange["author"], name = "howtos/a.md"): MemoryChange => ({
  scope: pipsOwn,
  path: path(name),
  title: name,
  version: version(`${name}@${at}`),
  author,
  at,
});

const byPip: MemoryChange["author"] = { _tag: "Hob", agentId: pip.id };
const byYou: MemoryChange["author"] = { _tag: "You" };

describe("the Memory page's address", () => {
  // covers ADR 028 (Browse), #958
  it("[TC-UX-940] reads every view from its address and writes it back the same", () => {
    const views: ReadonlyArray<MemoryView> = [
      { _tag: "Overview" },
      { _tag: "Changes", show: "all" },
      { _tag: "Changes", show: "you" },
      { _tag: "Scope", scope: pipsOwn, kind: null },
      { _tag: "Scope", scope: site, kind: "howto" },
      { _tag: "Page", scope: everyone, path: path("rules/ask.md"), version: null },
      { _tag: "Page", scope: pipsOwn, path: path("howtos/a.md"), version: version("v2") },
      { _tag: "Search", q: "preview", within: null },
      { _tag: "Search", q: "preview", within: docs },
    ];
    for (const view of views) expect(memoryViewOf(memorySearchOf(view))).toEqual(view);
    // A search wins over the rest; an unreadable scope or page falls back.
    expect(memoryViewOf({ q: " link ", scope: "everyone", view: "changes" })).toEqual({
      _tag: "Search",
      q: "link",
      within: null,
    });
    expect(memoryViewOf({ scope: "nowhere" })).toEqual({ _tag: "Overview" });
    expect(memoryViewOf({ scope: "everyone", page: "../secret" })).toEqual({
      _tag: "Scope",
      scope: everyone,
      kind: null,
    });
  });
});

describe("the scope list and the line under the title", () => {
  // covers ADR 028 (Browse), #958
  it("[TC-UX-941] lists About you, each project by name, each hob, and a former hob only while it holds pages", () => {
    const overview: MemoryOverview = {
      scopes: [
        { scope: everyone, pages: 2 },
        { scope: site, pages: 3 },
        { scope: docs, pages: 1 },
        { scope: pipsOwn, pages: 4 },
        { scope: formerOwn, pages: 1 },
      ],
    };
    const nav = scopeNav(overview, [pip, ada], hobs);
    expect(nav.about).toMatchObject({ key: "everyone", name: copy.nav.about, pages: 2 });
    expect(nav.projects.map((row) => [row.name, row.sub, row.pages])).toEqual([
      ["docs", "", 1],
      ["site", "github.com/me/site", 3],
    ]);
    expect(nav.hobs.map((row) => [row.name, row.pages])).toEqual([
      ["Pip", 4],
      ["Ada", 0],
      [copy.nav.formerHob, 1],
    ]);
    // While memory is read nothing is counted yet.
    const reading = scopeNav(undefined, [pip], hobs);
    expect(reading.projects).toEqual([]);
    expect(reading.hobs.map((row) => row.pages)).toEqual([null]);
    // Search offers only the places that hold a page.
    expect(searchScopes(nav).map((entry) => entry.label)).toEqual([
      copy.results.everywhere,
      copy.nav.about,
      "docs",
      "site",
      "Pip",
      copy.nav.formerHob,
    ]);
  });

  // covers ADR 028 (Browse), #958
  it("[TC-UX-942] says loading, nothing yet, what memory holds, or that it is not answering", () => {
    expect(headLine(2, undefined, { offline: false })).toBe(copy.head.loading({ hobs: 2 }));
    expect(headLine(2, { scopes: [] }, { offline: false })).toBe(copy.head.empty({ hobs: 2 }));
    const full: MemoryOverview = {
      scopes: [
        { scope: everyone, pages: 2 },
        { scope: site, pages: 3 },
        { scope: pipsOwn, pages: 4 },
      ],
    };
    expect(headLine(2, full, { offline: false })).toBe(copy.head.full({ hobs: 2, count: 9, shared: 2 }));
    expect(headLine(2, full, { offline: true })).toBe(copy.head.offline);
  });

  // covers ADR 028 (Browse), #958
  it("[TC-UX-943] shows memory down or a page gone at once, and retries anything else", () => {
    const queryClient = new QueryClient();
    expect(retryUnlessRefused(queryClient, 0, new ApiError("down", "MemoryNotAnswering"))).toBe(false);
    expect(retryUnlessRefused(queryClient, 0, new ApiError("gone", "MemoryPageNotFound"))).toBe(false);
    expect(retryUnlessRefused(queryClient, 0, new Error("other"))).toBe(true);
  });
});

describe("a scope's pages", () => {
  // covers ADR 028 (Browse), #958
  it("[TC-UX-944] groups pages by the kind their folder names, and counts each kind for the chips", () => {
    const pages = [
      summary("howtos/a.md"),
      summary("rules/b.md"),
      summary("howtos/c.md"),
      summary("sessions/d.md"),
      summary("loose.md"),
    ];
    expect(kindGroups(pages).map((group) => [group.kind, group.pages.map((page) => page.path)])).toEqual([
      ["rule", ["rules/b.md"]],
      ["howto", ["howtos/a.md", "howtos/c.md"]],
      ["chat", ["sessions/d.md"]],
      ["note", ["loose.md"]],
    ]);
    expect(kindChips(pages).map((chip) => [chip.kind, chip.count])).toEqual([
      ["all", 5],
      ["rule", 1],
      ["howto", 2],
      ["chat", 1],
      ["note", 1],
    ]);
    expect(kindChips([])).toEqual([{ kind: "all", label: copy.all, count: 0 }]);
  });
});

describe("what changed", () => {
  const now = new Date(2026, 10, 5, 12, 0);
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();

  // covers ADR 028 (What changed), #958
  it("[TC-UX-945] keeps the hobs' saves of the last week for Recently learned, and filters by who saved", () => {
    const changes = [
      change(at(5, 11), byPip),
      change(at(5, 10), byYou),
      change(at(4, 9), null),
      change(at(1, 9), byPip),
    ];
    expect(recentlyLearned([...changes, change(at(5, 11), byPip, "old/x.md")], now).length).toBe(3);
    expect(recentlyLearned(changes, new Date(2026, 10, 20))).toEqual([]);
    expect(recentlyLearned(changes, now, 1)).toEqual([changes[0]]);
    expect(filterChanges(changes, "all")).toEqual(changes);
    expect(filterChanges(changes, "hobs")).toEqual([changes[0], changes[3]]);
    expect(filterChanges(changes, "you")).toEqual([changes[1]]);
  });

  // covers ADR 028 (What changed), #958
  it("[TC-UX-946] groups changes by local day, newest first, naming today and yesterday", () => {
    const changes = [
      change(at(4, 9), byPip),
      change(at(5, 8), byYou),
      change(at(5, 11), byPip),
      change(at(2, 9), byPip),
    ];
    const days = changesByDay(changes, now);
    expect(days.map((day) => day.label)).toEqual([copy.changes.today, copy.changes.yesterday, null]);
    expect(days[0]?.rows.map((row) => row.at)).toEqual([at(5, 11), at(5, 8)]);
    expect(changesByDay([], now)).toEqual([]);
  });

  // covers ADR 028 (What changed), #958
  it("[TC-UX-947] adds what the stream brings once each, newest first", () => {
    const known = [change(at(5, 9), byPip)];
    const fresh = change(at(5, 11), byYou, "rules/new.md");
    const merged = withChanges(known, [fresh, known[0] as MemoryChange]);
    expect(merged).toEqual([fresh, known[0]]);
  });
});

describe("a page", () => {
  // covers ADR 028 (Read), #958
  it("[TC-UX-948] tells each version's story, newest first: who learned it, then who changed it", () => {
    const rows = historyRows(
      [
        { version: version("v3"), author: byYou, writtenAt: "2026-11-05T10:00:00.000Z", latest: true },
        {
          version: version("v2"),
          author: { _tag: "Hob", agentId: ada.id },
          writtenAt: "2026-11-04T10:00:00.000Z",
          latest: false,
        },
        { version: version("v1"), author: byPip, writtenAt: "2026-11-03T10:00:00.000Z", latest: false },
      ],
      hobs,
    );
    expect(rows.map((row) => [row.what, row.latest])).toEqual([
      [copy.page.youChanged, true],
      [copy.page.changedThis({ who: "Ada" }), false],
      [copy.page.learnedThis({ who: "Pip" }), false],
    ]);
    const yours = historyRows([{ version: version("v1"), author: byYou, writtenAt: "x", latest: true }], hobs);
    expect(yours[0]?.what).toBe(copy.page.wroteThis);
  });

  // covers ADR 028 (Read), #958
  it("[TC-UX-949] shows a version's changed lines without the blank ones, so paragraphs read as lines", () => {
    expect(
      shownLines([
        { op: "same", text: "# Title" },
        { op: "same", text: "" },
        { op: "remove", text: "Old line." },
        { op: "add", text: "  " },
        { op: "add", text: "New line." },
      ]),
    ).toEqual([
      { op: "same", text: "# Title" },
      { op: "remove", text: "Old line." },
      { op: "add", text: "New line." },
    ]);
  });
});

describe("search", () => {
  // covers ADR 028 (Search), #958
  it("[TC-UX-950] marks the words of a hit that match the search", () => {
    expect(hitParts("Publishing a preview link", "preview")).toEqual([
      { text: "Publishing a ", match: false },
      { text: "preview", match: true },
      { text: " link", match: false },
    ]);
    expect(hitParts("Nothing to mark", "   ")).toEqual([{ text: "Nothing to mark", match: false }]);
  });
});
