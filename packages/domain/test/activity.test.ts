import { describe, expect, it } from "vitest";
import {
  compareListings,
  DEFAULT_ACTIVITY_LIMITS,
  type FolderListing,
  foldersOverlap,
  foldLog,
  isSecretFile,
  keepPlan,
  runsInSequence,
} from "../src/index.ts";

const file = (hash: string, size = 10) => ({ kind: "file" as const, size, hash });
const link = (hash: string) => ({ kind: "link" as const, size: 5, hash });
const listing = (entries: Record<string, ReturnType<typeof file> | ReturnType<typeof link>>): FolderListing =>
  new Map(Object.entries(entries));

describe("compareListings", () => {
  it("names each added, edited and deleted file, in path order", () => {
    const changes = compareListings(
      listing({ "a.md": file("1"), "b.md": file("2"), "c.md": file("3") }),
      listing({ "a.md": file("1"), "b.md": file("2b"), "d.md": file("4") }),
    );
    expect(changes.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "b.md", kind: "edited" },
      { path: "c.md", kind: "deleted" },
      { path: "d.md", kind: "added" },
    ]);
  });

  it("pairs a removed file with an added one of the same contents as one move", () => {
    const changes = compareListings(
      listing({ "docs/old.md": file("same"), "z.md": file("same2") }),
      listing({ "docs/new.md": file("same"), "a.md": file("same2") }),
    );
    expect(changes).toEqual([
      { path: "a.md", kind: "moved", movedFrom: "z.md", before: file("same2"), after: file("same2") },
      { path: "docs/new.md", kind: "moved", movedFrom: "docs/old.md", before: file("same"), after: file("same") },
    ]);
  });

  it("reports a link as a link, whether it was added, changed or removed", () => {
    const changes = compareListings(
      listing({ out: link("t1"), gone: link("t2") }),
      listing({ out: link("t3"), "new": link("t4") }),
    );
    expect(changes.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "gone", kind: "link" },
      { path: "new", kind: "link" },
      { path: "out", kind: "link" },
    ]);
  });
});

describe("what a change keeps", () => {
  it("keeps no contents for files whose names mark them as secret, but does for a shared template", () => {
    for (const path of [".env", "app/.env.local", "id_ed25519", "certs/server.pem", "deploy.key", ".npmrc"]) {
      expect(isSecretFile(path)).toBe(true);
      expect(keepPlan(path, file("h"), DEFAULT_ACTIVITY_LIMITS)).toMatchObject({ readUpTo: null, notKept: "secret" });
    }
    for (const path of [".env.example", "src/env.ts", "keyboard.md", "id_rsa.pub"])
      expect(isSecretFile(path)).toBe(false);
  });

  it("keeps text up to its limit and images up to theirs, and says when one is too large", () => {
    const limits = DEFAULT_ACTIVITY_LIMITS;
    expect(keepPlan("a.md", file("h", limits.textBytes), limits)).toEqual({
      kind: "text",
      readUpTo: limits.textBytes,
      notKept: null,
    });
    expect(keepPlan("a.md", file("h", limits.textBytes + 1), limits)).toEqual({
      kind: "other",
      readUpTo: null,
      notKept: "too-large",
    });
    expect(keepPlan("logo.PNG", file("h", 5 * 1024 * 1024), limits)).toMatchObject({ kind: "image", notKept: null });
    expect(keepPlan("logo.png", file("h", limits.imageBytes + 1), limits)).toMatchObject({
      kind: "image",
      notKept: "too-large",
    });
    expect(keepPlan("out", link("t"), limits)).toEqual({ kind: "link", readUpTo: null, notKept: null });
  });
});

describe("foldLog", () => {
  it("keeps the whole output up to the limit, and past it the first and last halves with how much was left out", () => {
    expect(foldLog("short", 4096)).toEqual({ text: "short", totalBytes: 5, omittedBytes: 0 });
    const long = `${"a".repeat(3000)}\n${"b".repeat(3000)}\n${"c".repeat(3000)}\n`;
    const folded = foldLog(long, 8192);
    expect(folded.totalBytes).toBe(9003);
    expect(folded.text.startsWith("a")).toBe(true);
    expect(folded.text.endsWith("c\n")).toBe(true);
    expect(folded.omittedBytes).toBe(9003 - new TextEncoder().encode(folded.text).byteLength);
    expect(folded.omittedBytes).toBeGreaterThan(0);
  });
});

describe("foldersOverlap", () => {
  it("counts the same folder and one inside the other, never a sibling that shares a prefix", () => {
    expect(foldersOverlap("/work/site", "/work/site")).toBe(true);
    expect(foldersOverlap("/work/site", "/work/site/docs")).toBe(true);
    expect(foldersOverlap("/work/site/docs", "/work/site")).toBe(true);
    expect(foldersOverlap("/work/site", "/work/site-old")).toBe(false);
  });
});

describe("runsInSequence", () => {
  it("is true for a line that runs a command after another whatever its exit", () => {
    for (const line of ["git rev-parse --git-dir; git init", "make\nmake test", "sleep 1 & echo done"]) {
      expect(runsInSequence(line)).toBe(true);
    }
  });

  it("reads on after a heredoc's delimiter, and never in its body", () => {
    expect(runsInSequence("cat <<'EOF' > notes.md\nline; two\nEOF\nfalse\necho done")).toBe(true);
    expect(runsInSequence("cat <<-EOF\n\tbody\n\tEOF\nfalse")).toBe(true);
    expect(runsInSequence("cat <<A <<B\na; a\nA\nb & b\nB")).toBe(false);
    expect(runsInSequence("grep x <<< 'a; b'; echo done")).toBe(true);
    expect(runsInSequence("grep x <<< 'a; b'")).toBe(false);
    // The shell removes quotes and backslashes from the whole delimiter word.
    expect(runsInSequence("cat <<\\EOF\ntext\nEOF\nfalse\necho done")).toBe(true);
    expect(runsInSequence("cat <<E'OF'\ntext\nEOF\nfalse")).toBe(true);
    expect(runsInSequence('cat <<"E"O\\F > a.md\ntext; more\nEOF\nfalse')).toBe(true);
    expect(runsInSequence("cat <<\\EOF\na; b\nEOF")).toBe(false);
  });

  it("is false for one command, a chain on success or failure, a redirection and a quoted separator", () => {
    for (const line of [
      "pytest",
      "npm ci && npm test",
      "test -d .git || git init",
      "make 2>&1 | tee log",
      "cmd &> log",
      "echo 'a; b' \"c & d\"",
      "echo a\\;b",
      "make |& tee log",
      "npm test\n",
      "npm test;",
      "cat > notes.md <<'EOF'\nline one\nline two; three\nEOF",
    ]) {
      expect(runsInSequence(line)).toBe(false);
    }
  });
});
