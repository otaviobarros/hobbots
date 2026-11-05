import type { MemoryScopes } from "@hobbots/api";
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
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.ts";
import { retryUnlessRefused } from "../../api/live.ts";
import { applyMemoryChanged, memoryKeys, refreshMemory, withChanges } from "../../api/memory-pages.ts";
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
    const overview: MemoryScopes = {
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
    const full: MemoryScopes = {
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
      // Folders named like an object's own properties are no kind of their own.
      summary("constructor/e.md"),
      summary("__proto__/f.md"),
    ];
    expect(kindGroups(pages).map((group) => [group.kind, group.pages.map((page) => page.path)])).toEqual([
      ["rule", ["rules/b.md"]],
      ["howto", ["howtos/a.md", "howtos/c.md"]],
      ["chat", ["sessions/d.md"]],
      ["note", ["loose.md", "constructor/e.md", "__proto__/f.md"]],
    ]);
    expect(kindChips(pages).map((chip) => [chip.kind, chip.count])).toEqual([
      ["all", 7],
      ["rule", 1],
      ["howto", 2],
      ["chat", 1],
      ["note", 3],
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

  // covers ADR 028 (What changed), STD-REACT-012, #958
  it("[TC-UX-955] keeps a save the stream brings while What changed is still being read", async () => {
    const queryClient = new QueryClient();
    const before = [change(at(5, 9), byPip)];
    const fresh = change(at(5, 11), byYou, "rules/new.md");
    // The hub keeps what it found, so a read made after the event holds the save.
    let served: ReadonlyArray<MemoryChange> = before;
    const answers: Array<(changes: ReadonlyArray<MemoryChange>) => void> = [];
    const read = () =>
      queryClient.fetchQuery({
        queryKey: memoryKeys.changes,
        queryFn: () => new Promise<ReadonlyArray<MemoryChange>>((resolve) => answers.push(resolve)),
      });
    const observer = new QueryObserver(queryClient, {
      queryKey: memoryKeys.changes,
      queryFn: () => Promise.resolve(served),
    });
    const stop = observer.subscribe(() => {});
    void read().catch(() => undefined);
    served = [fresh, ...before];
    // The event lands before the first read answers, which answers from before the save.
    await applyMemoryChanged(queryClient, { _tag: "MemoryChanged", changes: [fresh] });
    for (const answer of answers) answer(before);
    await vi.waitFor(() => expect(queryClient.getQueryData(memoryKeys.changes)).toEqual([fresh, ...before]));
    stop();
  });

  // covers ADR 028 (Browse), #958
  it("[TC-UX-957] keeps a save made while the stream was away when it reconnects before the first read answers", async () => {
    const queryClient = new QueryClient();
    const before = [change(at(5, 9), byPip)];
    const missed = change(at(5, 11), byYou, "rules/new.md");
    let served: ReadonlyArray<MemoryChange> = before;
    const answers: Array<(changes: ReadonlyArray<MemoryChange>) => void> = [];
    const observer = new QueryObserver(queryClient, {
      queryKey: memoryKeys.changes,
      queryFn: () => Promise.resolve(served),
    });
    const stop = observer.subscribe(() => {});
    void queryClient
      .fetchQuery({
        queryKey: memoryKeys.changes,
        queryFn: () => new Promise<ReadonlyArray<MemoryChange>>((resolve) => answers.push(resolve)),
      })
      .catch(() => undefined);
    // The save lands while the stream is down, so no event brings it; the stream is ready again
    // before the first read answers, which answers from before the save.
    served = [missed, ...before];
    await refreshMemory(queryClient);
    for (const answer of answers) answer(before);
    await vi.waitFor(() => expect(queryClient.getQueryData(memoryKeys.changes)).toEqual([missed, ...before]));
    stop();
  });
});

describe("a page", () => {
  // covers ADR 028 (Read), #958
  it("[TC-UX-948] tells each version's story, newest first: who learned it, then who changed it", () => {
    const rows = historyRows(
      [
        {
          version: version("v3"),
          supersedes: version("v2"),
          author: byYou,
          writtenAt: "2026-11-05T10:00:00.000Z",
          latest: true,
        },
        {
          version: version("v2"),
          supersedes: version("v1"),
          author: { _tag: "Hob", agentId: ada.id },
          writtenAt: "2026-11-04T10:00:00.000Z",
          latest: false,
        },
        {
          version: version("v1"),
          supersedes: null,
          author: byPip,
          writtenAt: "2026-11-03T10:00:00.000Z",
          latest: false,
        },
      ],
      hobs,
    );
    expect(rows.map((row) => [row.what, row.latest])).toEqual([
      [copy.page.youChanged, true],
      [copy.page.changedThis({ who: "Ada" }), false],
      [copy.page.learnedThis({ who: "Pip" }), false],
    ]);
    const yours = historyRows(
      [{ version: version("v1"), supersedes: null, author: byYou, writtenAt: "x", latest: true }],
      hobs,
    );
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
