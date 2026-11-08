import { AgentId, AttemptActivity, AttemptId, FileChange, FileChangeId, type FileVersion } from "@hobbots/domain";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { attempt, CAMPAIGN } from "../../../test/quests.ts";
import {
  changeCounts,
  changePath,
  changeShow,
  codeDiff,
  documentBlocks,
  documentDiff,
  fileKindLabel,
  foldLines,
  leavesFile,
  lineCounts,
  selectedChange,
  sharedHobs,
  splitPath,
} from "./changes-model.ts";
import { remarkMarkChanges } from "./mark-changes.ts";

const AT = "2026-11-01T10:00:00.000Z";
const done = attempt(CAMPAIGN, "completed");

const version = (kind: FileVersion["kind"], fields: Partial<FileVersion> = {}): FileVersion => ({
  hash: "h",
  size: 3,
  kind,
  contentId: null,
  notKept: null,
  ...fields,
});

const change = (path: string, fields: Partial<ConstructorParameters<typeof FileChange>[0]> = {}) =>
  new FileChange({
    id: FileChangeId.make(`f-${path}`),
    attemptId: done.id,
    taskId: CAMPAIGN,
    folder: "/work",
    path,
    kind: "edited",
    movedFrom: null,
    before: version("text"),
    after: version("text"),
    sharedWith: [],
    settled: true,
    recordedAt: AT,
    ...fields,
  });

describe("how the Changes tab shows a file", () => {
  it("renders Markdown documents, diffs other text, shows images and links, and names anything else", () => {
    expect(changeShow(change("notes.md"))).toBe("document");
    expect(changeShow(change("docs/README.markdown"))).toBe("document");
    expect(changeShow(change("src/app.ts"))).toBe("code");
    expect(changeShow(change("notes.txt"))).toBe("code");
    expect(changeShow(change("logo.png", { before: version("image"), after: version("image") }))).toBe("image");
    expect(changeShow(change("logo.png", { kind: "added", before: null, after: version("image") }))).toBe("image");
    expect(changeShow(change("current", { kind: "link", before: null, after: version("link") }))).toBe("link");
    expect(changeShow(change("report.pdf", { before: version("other"), after: version("other") }))).toBe("other");
    // A text file that grew past the size kept for text is no longer one Hobbots can diff.
    expect(changeShow(change("data.json", { after: version("other", { notKept: "too-large" }) }))).toBe("other");
  });

  it("names a file's place on the hub, its folders and name, and its kind", () => {
    expect(changePath(change("src/app.ts"))).toBe("/work/src/app.ts");
    expect(changePath({ folder: "/", path: "app.ts" })).toBe("/app.ts");
    expect(splitPath("src/lib/app.ts")).toEqual({ dir: "src/lib/", name: "app.ts" });
    expect(splitPath("app.ts")).toEqual({ dir: "", name: "app.ts" });
    expect(fileKindLabel("report.pdf")).toBe("PDF");
    expect(fileKindLabel("Makefile")).toBeNull();
  });

  it("counts changes by kind", () => {
    const changes = [
      change("a.md", { kind: "added", before: null }),
      change("b.md"),
      change("c.md", { folder: "/other" }),
      change("d.md", { kind: "deleted", after: null }),
    ];
    expect(changeCounts(changes)).toEqual({ added: 1, edited: 2, deleted: 1, moved: 0, link: 0 });
  });

  it("knows which changes left a file for Files to list", () => {
    expect(leavesFile(change("a.md"))).toBe(true);
    expect(leavesFile(change("a.md", { kind: "added", before: null }))).toBe(true);
    expect(leavesFile(change("a.md", { kind: "deleted", after: null }))).toBe(false);
    expect(leavesFile(change("current", { kind: "link", before: null, after: version("link") }))).toBe(false);
  });

  it("shows the change a link asks for by its path, else the one picked, else the first", () => {
    const changes = [change("a.md"), change("b.md"), change("c.md")];
    expect(selectedChange(changes, null, undefined)?.path).toBe("a.md");
    expect(selectedChange(changes, "f-b.md", undefined)?.path).toBe("b.md");
    expect(selectedChange(changes, "f-b.md", "/work/c.md")?.path).toBe("c.md");
    expect(selectedChange(changes, "gone", "/work/gone.md")?.path).toBe("a.md");
    expect(selectedChange([], null, undefined)).toBeNull();
  });

  it("names the other hobs that worked in the same folder, never the Attempt's own", () => {
    const ada = AgentId.make("ada");
    const other = AttemptId.make("other");
    const mine = AttemptId.make("mine-again");
    const activity = new AttemptActivity({
      attempt: done,
      commands: [],
      changes: [],
      scans: [],
      artifacts: [],
      sharedWithHobs: [
        { attemptId: other, agentId: ada },
        { attemptId: mine, agentId: done.agentId },
      ],
      detailsClearedAt: null,
    });
    expect(sharedHobs(change("a.md", { sharedWith: [other, mine] }), activity)).toEqual([ada]);
    expect(sharedHobs(change("a.md"), activity)).toEqual([]);
  });
});

describe("a code diff", () => {
  it("marks added and removed lines with their numbers on each side", () => {
    const diff = codeDiff("one\ntwo\nthree\n", "one\n2\nthree\nfour\n");
    expect(diff).toMatchObject({ added: 2, removed: 1 });
    expect(diff.rows).toEqual([
      { kind: "same", before: 1, after: 1, text: "one" },
      { kind: "removed", before: 2, after: null, text: "two" },
      { kind: "added", before: null, after: 2, text: "2" },
      { kind: "same", before: 3, after: 3, text: "three" },
      { kind: "added", before: null, after: 4, text: "four" },
    ]);
  });

  it("shows an added file as all added lines and a deleted one as all removed", () => {
    expect(codeDiff(null, "a\nb\n")).toMatchObject({ added: 2, removed: 0 });
    expect(codeDiff("a\nb\n", null)).toMatchObject({ added: 0, removed: 2 });
    expect(codeDiff(null, "")).toEqual({ rows: [], added: 0, removed: 0 });
  });

  it("counts the lines a change added and removed, as its diff does", () => {
    expect(lineCounts("one\ntwo\nthree\n", "one\n2\nthree\nfour\n")).toEqual({ added: 2, removed: 1 });
    expect(lineCounts(null, "a\nb\n")).toEqual({ added: 2, removed: 0 });
    expect(lineCounts("a\n", null)).toEqual({ added: 0, removed: 1 });
  });

  it("folds unchanged runs to the lines around each change, and shows them all when asked", () => {
    const lines = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n");
    const before = `${lines(1, 20)}\n`;
    const after = `${lines(1, 9)}\nchanged\n${lines(11, 20)}\n`;
    const diff = codeDiff(before, after, 2);
    expect(diff.rows.map((row) => (row.kind === "folded" ? `… ${row.lines}` : `${row.kind} ${row.text}`))).toEqual([
      "… 7",
      "same line 8",
      "same line 9",
      "removed line 10",
      "added changed",
      "same line 11",
      "same line 12",
      "… 8",
    ]);
    expect(codeDiff(before, after, Number.POSITIVE_INFINITY).rows.some((row) => row.kind === "folded")).toBe(false);
  });

  it("folds a large file with many changes in one pass", () => {
    // 100,000 unchanged lines then 100,000 added ones: a fold that compared every unchanged line
    // with every change would make ten billion comparisons. The rows are built here, so the test
    // times the fold alone, not the diff before it.
    const same = Array.from({ length: 100_000 }, (_, i) => ({
      kind: "same" as const,
      before: i + 1,
      after: i + 1,
      text: "x",
    }));
    const added = Array.from({ length: 100_000 }, (_, i) => ({
      kind: "added" as const,
      before: null,
      after: 100_001 + i,
      text: "y",
    }));
    const started = performance.now();
    const rows = foldLines([...same, ...added], 3);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(rows[0]).toMatchObject({ kind: "folded", lines: 99_997 });
    expect(rows).toHaveLength(1 + 3 + 100_000);
  });
});

describe("a document's change", () => {
  it("splits a document into its top-level blocks as written, with where each starts", () => {
    expect(documentBlocks("# Notes\n\nFirst para\nstill first.\n\n- a\n- b\n")).toEqual([
      { start: 0, text: "# Notes" },
      { start: 9, text: "First para\nstill first." },
      { start: 34, text: "- a\n- b" },
    ]);
  });

  it("marks the blocks the change removed in the earlier version and those it added in the later one", () => {
    const before = "# Notes\n\nOld line.\n\nKept.\n";
    const after = "# Notes\n\nNew line.\n\nKept.\n\nMore.\n";
    const diff = documentDiff(before, after);
    const marked = (doc: typeof diff.before) =>
      [...(doc?.marks ?? [])].map(([start, mark]) => [mark, doc?.text.slice(start).split("\n")[0]]);
    expect(diff.before?.text).toBe(before);
    expect(marked(diff.before)).toEqual([["removed", "Old line."]]);
    expect(marked(diff.after)).toEqual([
      ["added", "New line."],
      ["added", "More."],
    ]);
  });

  it("marks nothing in a version shown alone", () => {
    expect(documentDiff(null, "Same.\n\nSame.\n")).toEqual({
      before: null,
      after: { text: "Same.\n\nSame.\n", marks: new Map() },
    });
  });
});

describe("marking a document's changed blocks", () => {
  const parse = (text: string) => unified().use(remarkParse).use(remarkGfm).parse(text);
  const labels = { added: "Added:", removed: "Removed:" } as const;

  it("wraps each changed block in place, and leaves definitions, which show nothing, unmarked", () => {
    const text = "See the [guide][g].\n\n[g]: https://example.com\n";
    const tree = parse(text);
    remarkMarkChanges(
      new Map([
        [0, "added"],
        [text.indexOf("[g]:"), "added"],
      ]),
      labels,
    )()(tree);
    expect(tree.children.map((node) => node.type)).toEqual(["changedBlock", "definition"]);
    const [wrapper] = tree.children as unknown as ReadonlyArray<{
      data: object;
      children: ReadonlyArray<{ type: string }>;
    }>;
    expect(wrapper?.data).toMatchObject({ hName: "ins" });
    expect(wrapper?.children.map((node) => node.type)).toEqual(["changeLabel", "paragraph"]);
  });
});
