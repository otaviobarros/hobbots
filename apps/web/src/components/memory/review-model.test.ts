import {
  Agent,
  AgentId,
  MemoryPath,
  MemoryProjectIdentity,
  type MemoryScope,
  MemoryShare,
  MemoryVersion,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { shareOfChange } from "../../api/memory-shares.ts";
import { entryAsker, entryPlace, entryRow, groupByPlace, memoryEntry, needsEntries } from "../inbox/inbox-entries.ts";
import { type HobDirectory, memorySearchOf, memoryViewOf } from "./memory-model.ts";
import { findingWhat, openItem, reviewItems, shareLines, shareOutcome, shareTitle, shareWhat } from "./review-model.ts";

// #960: what hobs want to share, as Memory › To review and the Inbox show it (ADR 028, Sharing).

const ada = AgentId.make("ada");
const hobs: HobDirectory = new Map([
  [
    ada,
    new Agent({
      id: ada,
      name: "Ada",
      roleTitle: "Builder",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
      lookSeed: 1,
      lookColor: "moss",
      configVersion: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
    }),
  ],
]);
const site: MemoryScope = { _tag: "Project", identity: MemoryProjectIdentity.make("github.com/me/site") };
const everyone: MemoryScope = { _tag: "Everyone" };
const now = new Date("2026-11-05T10:00:00.000Z");

const share = (id: string, overrides: Partial<MemoryShare> = {}) =>
  new MemoryShare({
    id,
    agentId: ada,
    work: "reply:m1",
    key: id,
    input: "input",
    scope: site,
    path: MemoryPath.make("howtos/deploy.md"),
    markdown: "# Deploy the site\n\nRun `pnpm deploy`.\n\nThen check the preview.",
    tags: ["deploy"],
    state: "waiting",
    pending: null,
    through: "review",
    edited: false,
    version: null,
    previous: null,
    replaced: null,
    threadId: null,
    messageId: null,
    createdAt: `2026-11-05T09:0${id.length}:00.000Z`,
    updatedAt: "2026-11-05T09:00:00.000Z",
    decidedAt: null,
    ...overrides,
  });

describe("what hobs want to share", () => {
  // covers ADR 028 (Sharing), #960
  it("[TC-UX-980] names a share by who asks, the kind of page and where it goes, with the lines it adds", () => {
    expect(shareWhat(share("a"), "Ada")).toBe("Ada wants to add a how-to to the site project");
    expect(shareWhat(share("a", { scope: everyone }), "Ada")).toBe("Ada wants to teach every hob");
    expect(shareTitle(share("a"))).toBe("Deploy the site");
    expect(shareLines(share("a"))).toEqual(["Run `pnpm deploy`.", "Then check the preview."]);
    expect(shareOutcome(share("a", { state: "shared" }), hobs)).toBe("Shared with the site project.");
    expect(shareOutcome(share("a", { state: "shared", scope: everyone }), hobs)).toBe(
      "Shared. Every hob follows it from its next chat.",
    );
    expect(shareOutcome(share("a", { state: "kept" }), hobs)).toBe("Kept private. Ada keeps it in its own memory.");
    expect(shareOutcome(share("a", { state: "undone" }), hobs)).toBe("Undone. The page is back in Ada's memory only.");
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-UX-981] lists in To review the shares that wait, then what Check now found, and keeps a decided share open", () => {
    const shares = [share("a"), share("bb", { state: "shared" })];
    const check = {
      checkedAt: "2026-11-05T09:30:00.000Z",
      findings: [{ kind: "disagree" as const, scope: site, paths: [MemoryPath.make("a.md")], message: "" }],
    };
    const items = reviewItems(shares, check);
    expect(items.map((item) => item.key)).toEqual(["a", "check:0"]);
    expect(openItem(items, shares, null)?.key).toBe("a");
    expect(openItem(items, shares, "check:0")?.key).toBe("check:0");
    // Decided where you look at it, it stays, with its outcome and Undo.
    expect(openItem(items, shares, "bb")).toMatchObject({ _tag: "Share", share: { state: "shared" } });
    expect(findingWhat(check.findings[0] ?? ({} as never))).toBe("A page disagrees with another");
    expect(memoryViewOf({ view: "review", item: "a" })).toEqual({ _tag: "Review", item: "a" });
    expect(memorySearchOf({ _tag: "Review", item: null })).toEqual({ view: "review" });
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-UX-982] shows a share in the Inbox as a Memory kind, with no rush, grouped apart from any chat", () => {
    const waiting = share("a");
    const entries = needsEntries({
      devices: [],
      questions: [],
      blockers: [],
      failed: [],
      requests: [],
      shares: [waiting, share("bb", { state: "kept" }), share("ccc", { state: "shared" })],
      selected: "memory:ccc",
    });
    // What waits, and the decided share the address names, so its Undo shows.
    expect(entries.map((entry) => entry.key)).toEqual(["memory:a", "memory:ccc"]);
    const entry = memoryEntry(waiting);
    expect(entryAsker(entry)).toBe(ada);
    expect(entryPlace(entry, () => undefined)).toEqual({ kind: "memory" });
    expect(entryRow(entry, () => "Ada", undefined, now)).toEqual({
      chain: ["Ada", "you"],
      kind: "Share",
      tag: "needs-you",
      what: "Ada wants to add a how-to to the site project",
      when: "No rush",
      tone: "plain",
    });
    expect(entryRow(memoryEntry(share("ccc", { state: "shared" })), () => "Ada", undefined, now).tag).toBe("muted");
    // Shares wait together, and a decided one goes last.
    expect(groupByPlace(entries, () => undefined).map((group) => [group.key, group.entries.length])).toEqual([
      ["memory", 2],
    ]);
  });

  // covers ADR 028 (Sharing), #960
  it("[TC-UX-983] finds the share that wrote a version, for Undo in What changed", () => {
    const shared = share("a", { state: "shared", through: "preset", version: MemoryVersion.make("v2") });
    const change = { scope: site, path: MemoryPath.make("howtos/deploy.md"), version: MemoryVersion.make("v2") };
    expect(shareOfChange([shared], change)).toBe(shared);
    expect(shareOfChange([shared], { ...change, version: MemoryVersion.make("v3") })).toBeUndefined();
    expect(shareOfChange([shared], { ...change, scope: everyone })).toBeUndefined();
  });
});
