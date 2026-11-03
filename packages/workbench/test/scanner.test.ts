import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentId, compareListings, DEFAULT_ACTIVITY_LIMITS } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { makeFolderScanner } from "../src/scanner.ts";
import { makeActivityStore } from "../src/store.ts";

// The folder scan of ADR 023: it reads files, never runs code from the folder, never follows a link
// out of it, and catches a change however it was made.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-scanner-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const limits = { maxFiles: DEFAULT_ACTIVITY_LIMITS.maxFiles, scanTimeoutMs: DEFAULT_ACTIVITY_LIMITS.scanTimeoutMs };
const folder = (name: string, files: Record<string, string>) => {
  const root = join(temp, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const paths = (listing: ReadonlyMap<string, unknown>) => [...listing.keys()].sort();

describe("the folder scan", () => {
  // covers UX-002, PE-002
  it("[TC-PE-276] reads a Git folder as files and never runs its config, hooks or tools", async () => {
    const marker = join(temp, "ran");
    const script = join(temp, "monitor.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    const repo = folder("repo", {
      "src/app.ts": "export {};\n",
      ".git/config": `[core]\n\tfsmonitor = ${script}\n[alias]\n\tst = !${script}\n`,
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/hooks/post-checkout": `#!/bin/sh\ntouch ${marker}\n`,
    });
    chmodSync(join(repo, ".git/hooks/post-checkout"), 0o755);
    const scanner = makeFolderScanner();

    const first = await Effect.runPromise(scanner.scan(repo, limits));
    writeFileSync(join(repo, "src/app.ts"), "export const changed = true;\n");
    const second = await Effect.runPromise(scanner.scan(repo, limits));

    expect(existsSync(marker)).toBe(false);
    expect(paths(first.listing)).toEqual(["src/app.ts"]);
    expect(compareListings(first.listing, second.listing).map((each) => each.kind)).toEqual(["edited"]);
  });

  // covers PE-002, PE-005
  it("[TC-PE-277] records a link as a link and never reads through it out of the folder", async () => {
    const outside = folder("outside", { "diary.txt": "Not for hobs.\n" });
    const root = folder("linked", { "notes.md": "# Notes\n" });
    symlinkSync(outside, join(root, "personal"));
    symlinkSync(join(outside, "diary.txt"), join(root, "diary-link.txt"));
    const scanner = makeFolderScanner();

    const scanned = await Effect.runPromise(scanner.scan(root, limits));

    expect(paths(scanned.listing)).toEqual(["diary-link.txt", "notes.md", "personal"]);
    expect(scanned.listing.get("personal")?.kind).toBe("link");
    expect(scanned.listing.get("diary-link.txt")?.kind).toBe("link");
    // Neither a link to a file nor a path through a linked folder is read.
    for (const path of ["diary-link.txt", "personal/diary.txt", "../outside/diary.txt"]) {
      expect(Option.isNone(await Effect.runPromise(scanner.read(root, path, 1024)))).toBe(true);
    }
    expect(Option.getOrThrow(await Effect.runPromise(scanner.read(root, "notes.md", 1024)))).toEqual(
      new TextEncoder().encode("# Notes\n"),
    );
  });

  // covers PE-002, PE-005
  it("[TC-PE-280] never reads outside the folder while a command swaps a folder in it for a link and back", async () => {
    const outside = folder("elsewhere", { "notes.md": "SECRET outside\n" });
    const root = folder("swapped", { "docs/notes.md": "inside\n" });
    const secret = createHash("sha256").update("SECRET outside\n").digest("hex");
    // A separate process swaps docs for a link to the outside folder and back, as fast as it can.
    const swapper = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       const docs = ${JSON.stringify(join(root, "docs"))}, kept = docs + "-real", out = ${JSON.stringify(outside)};
       const end = Date.now() + 3000;
       while (Date.now() < end) {
         try { fs.renameSync(docs, kept); fs.symlinkSync(out, docs); fs.unlinkSync(docs); fs.renameSync(kept, docs); } catch {}
       }`,
    ]);
    let swapping = true;
    const done = new Promise((resolve) => swapper.on("exit", resolve)).then(() => {
      swapping = false;
    });
    const scanner = makeFolderScanner();
    const seen: Array<string> = [];
    // Read and scan for as long as the swapper runs, however slow the machine is.
    while (swapping) {
      const read = await Effect.runPromise(scanner.read(root, "docs/notes.md", 1024));
      if (Option.isSome(read)) seen.push(new TextDecoder().decode(read.value));
      const scanned = await Effect.runPromise(scanner.scan(root, limits));
      for (const file of scanned.listing.values()) seen.push(file.hash);
    }
    await done;
    expect(seen.some((each) => each.includes("SECRET") || each === secret)).toBe(false);
  }, 20_000);

  // covers PE-002, PE-005
  it("[TC-PE-284] never reads the folder's new target when the folder itself is swapped for a link", async () => {
    const outside = folder("beyond", { "notes.md": "SECRET beyond\n" });
    const root = folder("given", { "notes.md": "inside\n" });
    const scanner = makeFolderScanner();
    expect(Option.isSome(await Effect.runPromise(scanner.read(root, "notes.md", 1024)))).toBe(true);
    // Another turn moves the hob's folder away and leaves a link to somewhere else in its place.
    renameSync(root, `${root}-moved`);
    symlinkSync(outside, root);

    expect(Option.isNone(await Effect.runPromise(scanner.read(root, "notes.md", 1024)))).toBe(true);
    expect(await Effect.runPromise(scanner.scan(root, limits))).toMatchObject({ stopped: "unreadable" });
  });

  // covers UX-002
  it("[TC-GEN-079] skips what .gitignore files ignore in a Git folder only, and .git and node_modules in any", async () => {
    const files = {
      ".gitignore": "dist/\n*.log\n!keep.log\n",
      "docs/.gitignore": "drafts/\n",
      "src/app.ts": "export {};\n",
      "dist/app.js": "built\n",
      "debug.log": "noise\n",
      "keep.log": "kept\n",
      "docs/guide.md": "# Guide\n",
      "docs/drafts/idea.md": "maybe\n",
      "node_modules/pkg/index.js": "module\n",
    };
    const git = folder("git", { ...files, ".git/HEAD": "ref: refs/heads/main\n" });
    const plain = folder("plain", files);
    const scanner = makeFolderScanner();

    const inGit = await Effect.runPromise(scanner.scan(git, limits));
    const notGit = await Effect.runPromise(scanner.scan(plain, limits));

    expect(paths(inGit.listing)).toEqual([".gitignore", "docs/.gitignore", "docs/guide.md", "keep.log", "src/app.ts"]);
    expect(paths(notGit.listing)).toEqual([
      ".gitignore",
      "debug.log",
      "dist/app.js",
      "docs/.gitignore",
      "docs/drafts/idea.md",
      "docs/guide.md",
      "keep.log",
      "src/app.ts",
    ]);
  });

  // covers UX-002
  it("[TC-GEN-080] catches a rewrite of the same size that puts the old modification time back", async () => {
    const root = folder("racy", { "config.json": '{"mode":"a"}\n' });
    const path = join(root, "config.json");
    const scanner = makeFolderScanner();
    // Long enough that the first scan's hash is the one later scans may reuse.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const before = await Effect.runPromise(scanner.scan(root, limits));
    const again = await Effect.runPromise(scanner.scan(root, limits));
    const { atime, mtime } = statSync(path);
    writeFileSync(path, '{"mode":"b"}\n');
    utimesSync(path, atime, mtime);

    const after = await Effect.runPromise(scanner.scan(root, limits));

    expect(compareListings(before.listing, again.listing)).toEqual([]);
    expect(statSync(path).mtime).toEqual(mtime);
    expect(compareListings(before.listing, after.listing).map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "config.json", kind: "edited" },
    ]);
  });

  // covers UX-002
  it("[TC-GEN-081] stops tracking a folder past its file limit, and says why", async () => {
    const root = folder("big", { "a.md": "a", "b.md": "b", "c.md": "c" });
    const scanned = await Effect.runPromise(makeFolderScanner().scan(root, { ...limits, maxFiles: 2 }));
    expect(scanned.stopped).toBe("too-many-files");
    expect(scanned.listing.size).toBe(0);
  });
});

describe("the details store", () => {
  // covers PE-005
  it("[TC-PE-278] keeps contents once per hash and never serves a file it did not write", async () => {
    const root = join(temp, "store");
    const store = makeActivityStore(root);
    const bytes = new TextEncoder().encode("formatted 3 files\n");

    const first = await Effect.runPromise(store.put(bytes));
    const second = await Effect.runPromise(store.put(bytes));
    expect(first.added).toBe(true);
    expect(second).toEqual({ id: first.id, added: false });
    expect(Option.getOrThrow(await Effect.runPromise(store.get(first.id)))).toEqual(bytes);
    expect(await Effect.runPromise(store.list)).toEqual([first.id]);

    // A link or a second name planted at a content's name is never read.
    const secret = join(temp, "secret.txt");
    writeFileSync(secret, "hunter2\n");
    const planted = ContentId.make("a".repeat(64));
    symlinkSync(secret, join(root, planted));
    const hardLinked = ContentId.make("b".repeat(64));
    linkSync(secret, join(root, hardLinked));
    expect(Option.isNone(await Effect.runPromise(store.get(planted)))).toBe(true);
    expect(Option.isNone(await Effect.runPromise(store.get(hardLinked)))).toBe(true);
    expect(Option.isNone(await Effect.runPromise(store.get(ContentId.make("../secret.txt"))))).toBe(true);

    await Effect.runPromise(store.remove([first.id, planted, hardLinked]));
    expect(Option.isNone(await Effect.runPromise(store.get(first.id)))).toBe(true);
    expect(readFileSync(secret, "utf8")).toBe("hunter2\n");
  });
});
