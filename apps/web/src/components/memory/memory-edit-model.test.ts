import {
  AgentId,
  MemoryForgetDay,
  type MemoryPage,
  MemoryPath,
  type MemoryScope,
  MemoryVersion,
  memoryPathFor,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  changedPage,
  draftOf,
  editorErrors,
  editorValid,
  houseRuleOf,
  localDay,
  markdownOf,
  newDraft,
  saveOf,
  suggestedForgetDay,
} from "./memory-edit-model.ts";
import { flashKeyOf, type MemoryView, memorySearchOf, memoryViewOf } from "./memory-model.ts";
import { messages } from "./messages.ts";

const copy = messages;
const pipsOwn: MemoryScope = { _tag: "Hob", agentId: AgentId.make("0d6e2f0a-0000-4000-8000-000000000011") };
const now = new Date(2026, 10, 5, 15, 0);

const page: MemoryPage = {
  scope: pipsOwn,
  path: MemoryPath.make("howtos/preview.md"),
  markdown: "# Publishing a preview link\n\nAsk Ada.\n",
  tags: ["site"],
  pinned: true,
  forgetOn: MemoryForgetDay.make("2026-12-05"),
  version: MemoryVersion.make("v2"),
  author: null,
  updatedAt: "2026-11-05T09:00:00.000Z",
};

describe("the Memory page's editor", () => {
  it("opens a page as its title, body, pin and forget day, and saves it back over the version it read", () => {
    const draft = draftOf(page, "howto");
    expect(draft).toEqual({
      title: "Publishing a preview link",
      body: "Ask Ada.",
      kind: "howto",
      pinned: true,
      forgetOn: "2026-12-05",
    });
    expect(
      saveOf({ ...draft, body: "Ask Ada for a link.", pinned: false, forgetOn: "" }, { scope: pipsOwn, page }),
    ).toEqual({
      scope: "hob:0d6e2f0a-0000-4000-8000-000000000011",
      path: "howtos/preview.md",
      markdown: "# Publishing a preview link\n\nAsk Ada for a link.\n",
      tags: ["site"],
      pinned: false,
      forgetOn: null,
      expected: "v2",
    });
  });

  it("writes a new page into its kind's folder, named after its title, and a house rule into About you", () => {
    const fresh = saveOf(
      { ...newDraft("gotcha"), title: "Don't edit Banner.astro alone!" },
      { scope: pipsOwn, page: null },
    );
    expect(fresh).toMatchObject({ path: "gotchas/don-t-edit-banner-astro-alone.md", expected: null, tags: [] });
    expect(memoryPathFor("rule", "Écrire « court »")).toBe("rules/ecrire-court.md");
    expect(memoryPathFor("fact", "!!!")).toBe("facts/page.md");
    expect(memoryPathFor("decision", "x".repeat(200))).toMatch(/^decisions\/x{60}\.md$/);
    expect(houseRuleOf("Use pnpm, not npm.")).toEqual({
      scope: "everyone",
      path: "rules/use-pnpm-not-npm.md",
      markdown: "# Use pnpm, not npm.\n",
      tags: [],
      pinned: false,
      forgetOn: null,
      expected: null,
    });
    expect(markdownOf({ title: "  Two\n lines ", body: "" })).toBe("# Two lines\n");
  });

  it("asks for a title, a page that fits and a forget day still to come", () => {
    const draft = { ...newDraft("rule"), title: "Keep it short" };
    expect(editorValid(editorErrors(draft, now))).toBe(true);
    expect(editorErrors({ ...draft, title: "  " }, now)).toEqual({ title: copy.editor.titleMissing });
    expect(editorErrors({ ...draft, body: "x".repeat(70_000) }, now)).toEqual({ body: copy.editor.tooLong });
    expect(editorErrors({ ...draft, forgetOn: localDay(now) }, now)).toEqual({ forgetOn: copy.editor.dayPast });
    expect(editorErrors({ ...draft, forgetOn: "soon" }, now)).toEqual({ forgetOn: copy.editor.dayPast });
    expect(editorValid(editorErrors({ ...draft, forgetOn: suggestedForgetDay(now) }, now))).toBe(true);
    expect(suggestedForgetDay(now)).toBe("2026-12-05");
  });

  it("pins and sets a forget day on the page as it is, over the version on screen", () => {
    expect(changedPage(page, { pinned: false })).toMatchObject({
      markdown: page.markdown,
      tags: ["site"],
      pinned: false,
      forgetOn: "2026-12-05",
      expected: "v2",
    });
    expect(changedPage(page, { forgetOn: null })).toMatchObject({ pinned: true, forgetOn: null });
  });

  it("keeps the editor in the address, and a line said on save with the page it returns to", () => {
    const edit: MemoryView = { _tag: "Edit", scope: pipsOwn, path: page.path };
    const fresh: MemoryView = { _tag: "New", scope: pipsOwn, kind: "rule" };
    for (const view of [edit, fresh]) expect(memoryViewOf(memorySearchOf(view))).toEqual(view);
    expect(flashKeyOf(edit)).toBe(flashKeyOf({ _tag: "Page", scope: pipsOwn, path: page.path, version: null }));
    expect(flashKeyOf(fresh)).toBe(flashKeyOf({ _tag: "Scope", scope: pipsOwn, kind: null }));
    expect(flashKeyOf(edit)).not.toBe(flashKeyOf({ _tag: "Overview" }));
  });
});
