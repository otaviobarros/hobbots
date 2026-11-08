import {
  AgentId,
  Attempt,
  AttemptActivity,
  AttemptId,
  compareListings,
  FileChange,
  FileChangeId,
  type FileChangeKind,
  type FileVersion,
  type FolderListing,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { attempt, COPY } from "../../../test/quests.ts";
import { taskChanges } from "./task-changes.ts";

const AT = "2026-11-01T10:00:00.000Z";

const tryOf = (number: number): Attempt =>
  new Attempt({ ...attempt(COPY, number === 3 ? "completed" : "failed"), id: AttemptId.make(`try-${number}`), number });

const text = (hash: string, kind: "file" | "link" = "file"): FileVersion => ({
  hash,
  size: 4,
  kind: kind === "link" ? "link" : "text",
  contentId: null,
  notKept: null,
});

const change = (
  of: Attempt,
  path: string,
  kind: FileChangeKind,
  before: string | null,
  after: string | null,
  movedFrom: string | null = null,
) =>
  new FileChange({
    id: FileChangeId.make(`${of.id}-${path}`),
    attemptId: of.id,
    taskId: COPY,
    folder: "/work",
    path,
    kind,
    movedFrom,
    before: before === null ? null : text(before),
    after: after === null ? null : text(after),
    sharedWith: [],
    settled: true,
    recordedAt: AT,
  });

const recorded = (
  of: Attempt,
  changes: ReadonlyArray<FileChange>,
  sharedWithHobs: AttemptActivity["sharedWithHobs"] = [],
) =>
  new AttemptActivity({
    attempt: of,
    commands: [],
    changes: [...changes],
    scans: [],
    artifacts: [],
    sharedWithHobs: [...sharedWithHobs],
    detailsClearedAt: null,
  });

const first = tryOf(1);
const second = tryOf(2);
const third = tryOf(3);

/** Each file as the list shows it: its path, how it changed, where it was, its versions, and the tries that changed it. */
const shown = (activities: ReadonlyArray<AttemptActivity>) =>
  taskChanges(activities).map(({ change: each, beforeIn, afterIn, attempts }) => ({
    path: each.path,
    kind: each.kind,
    movedFrom: each.movedFrom,
    before: each.before?.hash ?? null,
    after: each.after?.hash ?? null,
    keptIn: [beforeIn.attempt.number, afterIn.attempt.number],
    tries: attempts.map((one) => one.number),
  }));

describe("a Task's changes across its tries", () => {
  it("lists a try's own changes as they are", () => {
    const one = recorded(first, [change(first, "Makefile", "added", null, "m1")]);
    const [only] = taskChanges([one]);
    expect(only?.change).toBe(one.changes[0]);
    expect(only?.activity).toBe(one);
  });

  it("keeps what a stopped try changed beside what the retry changed (#1218)", () => {
    expect(
      shown([
        recorded(first, [
          change(first, "Makefile", "added", null, "m1"),
          change(first, "scripts/check.sh", "added", null, "c1"),
        ]),
        recorded(second, [change(second, "report.md", "edited", "r0", "r1")]),
      ]),
    ).toEqual([
      { path: "Makefile", kind: "added", movedFrom: null, before: null, after: "m1", keptIn: [1, 1], tries: [1] },
      { path: "report.md", kind: "edited", movedFrom: null, before: "r0", after: "r1", keptIn: [2, 2], tries: [2] },
      {
        path: "scripts/check.sh",
        kind: "added",
        movedFrom: null,
        before: null,
        after: "c1",
        keptIn: [1, 1],
        tries: [1],
      },
    ]);
  });

  it("reads a file one try made and the retry rewrote as added, its versions from each try's records", () => {
    expect(
      shown([
        recorded(first, [change(first, "notes.sh", "added", null, "n13")]),
        recorded(second, [change(second, "notes.sh", "edited", "n13", "n20")]),
      ]),
    ).toEqual([
      { path: "notes.sh", kind: "added", movedFrom: null, before: null, after: "n20", keptIn: [1, 2], tries: [1, 2] },
    ]);
  });

  it("follows a file moved across tries back to where it was before the first", () => {
    expect(
      shown([
        recorded(first, [change(first, "docs/notes.txt", "moved", "n", "n", "notes.txt")]),
        recorded(second, [change(second, "docs/NOTES.md", "moved", "n", "n", "docs/notes.txt")]),
        recorded(third, [change(third, "docs/NOTES.md", "edited", "n", "n2")]),
      ]),
    ).toEqual([
      {
        path: "docs/NOTES.md",
        kind: "moved",
        movedFrom: "notes.txt",
        before: "n",
        after: "n2",
        keptIn: [1, 3],
        tries: [1, 2, 3],
      },
    ]);
  });

  it("drops a file a later try took back: made then deleted, or put back as it was", () => {
    expect(
      shown([
        recorded(first, [change(first, "tmp.txt", "added", null, "t"), change(first, "a.md", "edited", "a0", "a1")]),
        recorded(second, [
          change(second, "tmp.txt", "deleted", "t", null),
          change(second, "a.md", "edited", "a1", "a0"),
        ]),
      ]),
    ).toEqual([]);
  });

  it("reads a file a try made where an earlier one deleted it as edited", () => {
    expect(
      shown([
        recorded(first, [change(first, "a.md", "deleted", "a0", null)]),
        recorded(second, [change(second, "a.md", "added", null, "a1")]),
      ]),
    ).toEqual([
      { path: "a.md", kind: "edited", movedFrom: null, before: "a0", after: "a1", keptIn: [1, 2], tries: [1, 2] },
    ]);
  });

  it("reads a file moved off a path where a new one is then made as that path's edit and a new file, as a commit would", () => {
    expect(
      shown([
        recorded(first, [change(first, "a.md", "edited", "a0", "a1")]),
        recorded(second, [
          change(second, "b.md", "moved", "a1", "a1", "a.md"),
          change(second, "a.md", "added", null, "x"),
        ]),
      ]),
    ).toEqual([
      { path: "a.md", kind: "edited", movedFrom: null, before: "a0", after: "x", keptIn: [1, 2], tries: [1, 2] },
      { path: "b.md", kind: "added", movedFrom: null, before: null, after: "a1", keptIn: [2, 2], tries: [1, 2] },
    ]);
  });

  it("keeps a file a try deleted when a later try moves another onto its path and back (#1218)", () => {
    expect(
      shown([
        recorded(first, [change(first, "b.md", "deleted", "b0", null)]),
        recorded(second, [change(second, "b.md", "moved", "a0", "a0", "a.md")]),
        recorded(third, [change(third, "a.md", "moved", "a0", "a0", "b.md")]),
      ]),
    ).toEqual([
      { path: "b.md", kind: "deleted", movedFrom: null, before: "b0", after: null, keptIn: [1, 3], tries: [1, 2, 3] },
    ]);
  });

  it("reads a file moved onto a path that held another as that path's edit, and the path it left as deleted", () => {
    expect(
      shown([
        recorded(first, [change(first, "b.md", "deleted", "b0", null)]),
        recorded(second, [change(second, "b.md", "moved", "a0", "a0", "a.md")]),
      ]),
    ).toEqual([
      { path: "a.md", kind: "deleted", movedFrom: null, before: "a0", after: null, keptIn: [2, 2], tries: [2] },
      { path: "b.md", kind: "edited", movedFrom: null, before: "b0", after: "a0", keptIn: [1, 2], tries: [1, 2] },
    ]);
  });

  it("keeps two files that swapped places in one try as two edits", () => {
    expect(
      shown([
        recorded(first, [
          change(first, "a.md", "moved", "b0", "b0", "b.md"),
          change(first, "b.md", "moved", "a0", "a0", "a.md"),
        ]),
      ]).map(({ path, kind, before, after }) => ({ path, kind, before, after })),
    ).toEqual([
      { path: "a.md", kind: "edited", before: "a0", after: "b0" },
      { path: "b.md", kind: "edited", before: "b0", after: "a0" },
    ]);
  });

  it("keeps a file a later try made a link holding the same text, as a link is not that file", () => {
    const link: FileVersion = { ...text("t"), kind: "link" };
    const one = recorded(first, [change(first, "a.md", "edited", "a0", "t")]);
    const two = recorded(second, [{ ...change(second, "a.md", "link", "t", null), after: link }]);
    expect(shown([one, two])).toEqual([
      { path: "a.md", kind: "link", movedFrom: null, before: "a0", after: "t", keptIn: [1, 2], tries: [1, 2] },
    ]);
  });

  it("keeps who else worked there while an earlier try changed a file a solo retry changed again", () => {
    const ada = AgentId.make("ada");
    const hers = AttemptId.make("ada-try");
    const one = recorded(
      first,
      [{ ...change(first, "a.md", "edited", "a0", "a1"), sharedWith: [hers] }],
      [{ attemptId: hers, agentId: ada }],
    );
    const two = recorded(second, [change(second, "a.md", "edited", "a1", "a2")]);
    const [only] = taskChanges([one, two]);
    expect(only?.change.sharedWith).toEqual([hers]);
    expect(only?.sharedWithHobs).toEqual([{ attemptId: hers, agentId: ada }]);
  });

  it("reads a file made where an earlier try moved one off, then moved on, as added, not a second move", () => {
    expect(
      shown([
        recorded(first, [change(first, "b.md", "moved", "A", "A", "a.md")]),
        recorded(second, [change(second, "a.md", "added", null, "X")]),
        recorded(third, [change(third, "c.md", "moved", "X", "X", "a.md")]),
      ]),
    ).toEqual([
      { path: "b.md", kind: "moved", movedFrom: "a.md", before: "A", after: "A", keptIn: [1, 1], tries: [1] },
      { path: "c.md", kind: "added", movedFrom: null, before: null, after: "X", keptIn: [3, 3], tries: [2, 3] },
    ]);
  });

  it("drops a file moved off, made again as it was, and the moved one deleted, as the folder is as it began", () => {
    const tries = (again: string) => [
      recorded(first, [change(first, "b.md", "moved", "A", "A", "a.md")]),
      recorded(second, [change(second, "a.md", "added", null, again)]),
      recorded(third, [change(third, "b.md", "deleted", "A", null)]),
    ];
    expect(shown(tries("A"))).toEqual([]);
    expect(shown(tries("X"))).toEqual([
      { path: "a.md", kind: "edited", movedFrom: null, before: "A", after: "X", keptIn: [1, 2], tries: [1, 2] },
    ]);
  });

  it("reads a file made, deleted and made again where one was moved off, then moved on, as added", () => {
    const fourth = new Attempt({ ...tryOf(4), id: AttemptId.make("try-4"), number: 4 });
    const fifth = new Attempt({ ...tryOf(5), id: AttemptId.make("try-5"), number: 5 });
    expect(
      shown([
        recorded(first, [change(first, "b.md", "moved", "A", "A", "a.md")]),
        recorded(second, [change(second, "a.md", "added", null, "X")]),
        recorded(third, [change(third, "a.md", "deleted", "X", null)]),
        recorded(fourth, [change(fourth, "a.md", "added", null, "Y")]),
        recorded(fifth, [change(fifth, "c.md", "moved", "Y", "Y", "a.md")]),
      ]),
    ).toEqual([
      { path: "b.md", kind: "moved", movedFrom: "a.md", before: "A", after: "A", keptIn: [1, 1], tries: [1] },
      {
        path: "c.md",
        kind: "added",
        movedFrom: null,
        before: null,
        after: "Y",
        keptIn: [5, 5],
        tries: [2, 3, 4, 5],
      },
    ]);
  });
});

/** A small PRNG, so the generated tries are the same on every run. */
const random = (seed: number) => () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
  return ((seed ^ (seed >>> 13)) >>> 0) / 2 ** 32;
};

type Listing = Map<string, { readonly kind: "file" | "link"; readonly size: number; readonly hash: string }>;

/** One try's work on a folder of a few paths: moves, deletions, new files, edits and links. */
const work = (next: () => number, start: Listing): Listing => {
  const paths = ["a", "b", "c"];
  const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(next() * items.length)] as A;
  const now = new Map(start);
  for (let step = 1 + Math.floor(next() * 2); step > 0; step -= 1) {
    const at = pick(paths);
    const to = pick(paths);
    // Moves come up most, as they are what the tries' records can confuse.
    const action = pick(["move", "move", "move", "delete", "write", "write", "link"]);
    const there = now.get(at);
    if (action === "move" && there !== undefined && !now.has(to)) {
      now.delete(at);
      now.set(to, there);
    } else if (action === "delete") now.delete(at);
    else if (action === "write") now.set(at, { kind: "file", size: 1, hash: pick(["A", "B", "X"]) });
    else if (action === "link") now.set(at, { kind: "link", size: 1, hash: pick(["A", "X"]) });
  }
  return now;
};

/** What each path held first and holds last, for every path that differs, with a move split back into its two paths. */
const byPath = (changes: ReadonlyArray<Pick<FileChange, "path" | "movedFrom" | "before" | "after">>) => {
  const facts = new Map<string, { before: string | null; after: string | null }>();
  // Each side of each path is said once: two rows that name one path's first or last contents,
  // such as two moves from one path, are a fault, not two facts to merge.
  const said = new Set<string>();
  const show = (version: FileVersion | null) => (version === null ? null : `${version.kind}:${version.hash}`);
  const say = (path: string, side: "before" | "after", version: FileVersion | null) => {
    if (said.has(`${side}:${path}`)) throw new Error(`Two rows say what ${path} held ${side}`);
    said.add(`${side}:${path}`);
    facts.set(path, { ...(facts.get(path) ?? { before: null, after: null }), [side]: show(version) });
  };
  for (const each of changes) {
    say(each.movedFrom ?? each.path, "before", each.before);
    say(each.path, "after", each.after);
  }
  return [...facts].sort(([a], [b]) => (a < b ? -1 : 1));
};

describe("a Task's changes across generated tries", () => {
  it("always sum to what the folder held before the first try against what the last left", () => {
    for (let seed = 1; seed <= 10000; seed += 1) {
      const next = random(seed);
      // Half the runs start with a second file, so moves land both on empty paths and beside others.
      const start: Listing = new Map([
        ["a", { kind: "file", size: 1, hash: "A" }],
        ...(seed % 2 === 0 ? ([["b", { kind: "file", size: 1, hash: "B" }]] as const) : []),
      ]);
      let now = start;
      const activities: Array<AttemptActivity> = [];
      const count = 1 + Math.floor(next() * 8);
      for (let number = 1; number <= count; number += 1) {
        const of = new Attempt({ ...tryOf(1), id: AttemptId.make(`gen-${number}`), number });
        const after = work(next, now);
        const version = (file: { kind: "file" | "link"; size: number; hash: string } | null): FileVersion | null =>
          file === null
            ? null
            : { ...file, kind: file.kind === "link" ? "link" : "text", contentId: null, notKept: null };
        const records = compareListings(now as FolderListing, after as FolderListing).map(
          (each) =>
            new FileChange({
              ...change(of, each.path, each.kind, null, null, each.movedFrom),
              before: version(each.before),
              after: version(each.after),
            }),
        );
        activities.push(recorded(of, records));
        now = after;
      }
      // Path by path, with no move paired: what each path held before the first try and holds now.
      const show = (file: Listing extends Map<string, infer F> ? F | undefined : never) =>
        file === undefined ? null : `${file.kind === "link" ? "link" : "text"}:${file.hash}`;
      const expected = [...new Set([...start.keys(), ...now.keys()])]
        .map((path) => [path, { before: show(start.get(path)), after: show(now.get(path)) }] as const)
        .filter(([, each]) => each.before !== each.after)
        .sort(([a], [b]) => (a < b ? -1 : 1));
      const got = byPath(taskChanges(activities).map((each) => each.change));
      expect(got, `seed ${seed}`).toEqual(expected);
    }
  });
});
