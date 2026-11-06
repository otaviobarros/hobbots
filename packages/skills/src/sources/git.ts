import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type SkillTree, TREE_ENTRIES_MAX, type TreeEntry, TreeUnreadable } from "../tree.ts";

const execFileAsync = promisify(execFile);

/** The transports import fetches over. `ext::` and the like, which run programs, are off. */
const PROTOCOLS = ["https", "ssh", "file"];

/**
 * Settings for every Git command import runs. The fetch goes into an empty bare repository whose
 * hooks folder is empty, so no hook of yours, of a template, or of the source ever runs, and
 * nothing is checked out: files are read from Git's objects.
 */
const gitArgs = (hooks: string) => [
  "-c",
  `core.hooksPath=${hooks}`,
  "-c",
  "protocol.allow=never",
  ...PROTOCOLS.flatMap((protocol) => ["-c", `protocol.${protocol}.allow=always`]),
  "-c",
  "core.symlinks=false",
];

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

/** One line of `git ls-tree -r -l -z`: `<mode> <type> <object> <size>\t<path>`. */
const entryOf = (line: string): (TreeEntry & { readonly object: string }) | null => {
  const tab = line.indexOf("\t");
  if (tab === -1) return null;
  const [mode = "", , object = "", size = "0"] = line.slice(0, tab).split(/\s+/);
  const path = line.slice(tab + 1);
  const kind: TreeEntry["kind"] =
    mode === "120000" ? "symlink" : mode === "100644" || mode === "100755" ? "file" : "other";
  return { path, kind, executable: mode === "100755", size: kind === "file" ? Number(size) : 0, object };
};

/** The folders that hold the listed entries, which `ls-tree -r` leaves out. */
const foldersOf = (paths: ReadonlyArray<string>): ReadonlyArray<TreeEntry> => {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
  }
  return [...folders].sort().map((path) => ({ path, kind: "directory", executable: false, size: 0 }));
};

/** A Git repository at `ref` (its default branch when null), read at one commit and then removed. */
export const gitTree = async (url: string, ref: string | null): Promise<SkillTree & { close: () => Promise<void> }> => {
  if (url.startsWith("-") || (ref ?? "").startsWith("-")) throw new TreeUnreadable("That is not a Git address.");
  const home = await mkdtemp(join(tmpdir(), "hobbots-skill-git-"));
  const close = () => rm(home, { recursive: true, force: true });
  const repository = join(home, "repository.git");
  const hooks = join(home, "hooks");
  const git = (args: ReadonlyArray<string>, maxBuffer = 16 * 1024 * 1024) =>
    execFileAsync("git", [...gitArgs(hooks), "-C", repository, ...args], {
      env: ENV,
      timeout: 120_000,
      maxBuffer,
      encoding: "buffer",
    }).then(({ stdout }) => stdout);
  try {
    await mkdir(hooks);
    await execFileAsync("git", ["init", "--quiet", "--bare", "--template=", repository], { env: ENV });
    await git(["fetch", "--quiet", "--depth=1", "--no-tags", "--", url, ref ?? "HEAD"]);
    const commit = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString("utf8").trim();
    const listing = (await git(["ls-tree", "-r", "-l", "-z", "--full-tree", commit], 64 * 1024 * 1024))
      .toString("utf8")
      .split("\0")
      .filter((line) => line !== "");
    if (listing.length > TREE_ENTRIES_MAX)
      throw new TreeUnreadable(`The repository holds more than ${TREE_ENTRIES_MAX} files.`);
    const listed = listing.flatMap((line) => entryOf(line) ?? []);
    const objects = new Map(listed.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry.object]));
    const entries = [
      ...foldersOf(listed.map((entry) => entry.path)),
      ...listed.map(({ object: _, ...entry }) => entry),
    ];
    return {
      entries,
      commit,
      close,
      read: async (path) => {
        const object = objects.get(path);
        if (object === undefined) throw new TreeUnreadable(`${path} is not a file of the repository.`);
        return git(["cat-file", "blob", object], 64 * 1024 * 1024);
      },
    };
  } catch (error) {
    await close();
    if (error instanceof TreeUnreadable) throw error;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new TreeUnreadable(`Could not fetch ${url}${ref === null ? "" : ` at ${ref}`}: ${message}`);
  }
};
