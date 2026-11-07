import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type AskableVerdict,
  HubRefusal,
  hubAction,
  LocalGitTools,
  makeHubActions,
  openTools,
  operationDecision,
  type ToolAccess,
} from "@hobbots/agents";
import {
  GIT_INIT_DESCRIPTION,
  GIT_INIT_LABEL,
  GIT_INIT_TOOL,
  GitInitInput,
  gitInitToolJsonSchema,
  narrowest,
} from "@hobbots/domain";

import { decideHubCall, PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runTool, toolEnv } from "./run-tool.ts";

/**
 * Local Git work the hub does for a hob (ADR 014, #578): `git_init` creates a repository. A turn's
 * sandbox keeps every repository's `.git/config` and `.git/hooks` read-only, so the user's own Git
 * never runs what a hob wrote there, and that also stops `git init`, which must write a config. The
 * hub decides the call as Local Git and Edit files on the folder under the hob's policy, has Git
 * create the repository with no template in a folder of the hub's own, where no hob's command
 * reaches, and copies it to the folder's `.git` without following links (`PUBLISH_SCRIPT`). The
 * repository starts with Git's own config and no hooks, and the hob commits in it as usual. A `.git`
 * that holds only a config and hooks, which the sandbox keeps when a hob deletes a repository, is
 * replaced (#663). It runs through the hub action pipeline (ADR 031), which decides, asks, records
 * and runs it; it takes no key, since it refuses a folder that already holds a repository, so a
 * retried call never creates a second.
 */

/** What a `git_init` decides, both together: Local Git on the folder, and Edit files on it. */
interface GitInitRequest {
  readonly _tag: "GitInit";
  readonly command: PolicyRequest;
  readonly files: PolicyRequest;
}

/** What the hob is told once the repository is there. */
export const initializedText = (folder: string) =>
  `Created an empty Git repository in ${folder}. Add, commit and branch in it with git as usual; its .git/config and .git/hooks stay read-only for you, so ask the user to add a remote or install a hook.`;

/** What the hob is told when the repository took the place of a stub `.git` a delete left (#663). */
export const REPLACED = "It replaced the .git that was there, which held only a config and hooks.";

/** What a hob on Linux is told when the repository is at the top of a folder its running turn cannot see yet. */
export const NEXT_TURN =
  "On this hub your commands see a new repository at the top of a folder from your next turn: finish this turn and continue in the next.";

/** What the hob is told once the repository is at `target`, the top of its folder when `atTop`. */
const createdText = (target: string, replace: boolean, atTop: boolean) =>
  [
    initializedText(target),
    ...(replace ? [REPLACED] : []),
    // Bubblewrap fixes a turn's mounts when it starts, and holds a missing `.git` at the top of a folder;
    // a stub's `.git` is there, so its replacement shows at once.
    ...(process.platform === "linux" && atTop && !replace ? [NEXT_TURN] : []),
  ].join(" ");

/** Whether `path` names something inside a Git directory, where a new repository has no place. */
const insideGitDirectory = (path: string) => path.split(sep).includes(".git");

/** What a sandbox keeps from a delete inside `.git`, as paths relative to it (ADR 014). */
export const KEPT = /^(config$|hooks\/)/;

/** Up to `limit` files in `git` that `KEPT` does not name, as paths relative to it. */
const strays = (git: string, limit: number) => {
  const found: Array<string> = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (found.length >= limit) return;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!KEPT.test(relative(git, path).split(sep).join("/"))) found.push(relative(git, path));
    }
  };
  walk(git);
  return found;
};

/**
 * What stands at `<folder>/.git`: nothing, a repository (or a `.git` file pointing to one), a stub a
 * delete left, holding only what `KEPT` names besides folders, or something else, with some of the
 * files a stub would not hold.
 */
const gitDirectory = (folder: string) => {
  const git = join(folder, ".git");
  const stat = lstatSync(git, { throwIfNoEntry: false });
  if (stat === undefined) return { _tag: "None" } as const;
  if (!stat.isDirectory() || lstatSync(join(git, "HEAD"), { throwIfNoEntry: false })) {
    return { _tag: "Repository" } as const;
  }
  const other = strays(git, 6);
  return other.length === 0 ? ({ _tag: "Stub" } as const) : ({ _tag: "Other", other } as const);
};

/** A branch name plain enough to pass to `git init --initial-branch`. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** A folder as the file system resolves it, so a link and its target are the same folder. */
const canonical = (folder: string) => {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
};

/**
 * The narrower of two verdicts on the same call, its targets the first's. Two asks ask once, and
 * Always saves the rules of both, so the next call is answered by both.
 */
export const narrowerOf = (first: AskableVerdict, second: AskableVerdict): AskableVerdict => {
  if (first.decision === "ask" && second.decision === "ask") {
    const onceOnly = first.onceOnly || second.onceOnly;
    return {
      ...first,
      onceOnly,
      grantable: !onceOnly && first.grantable && second.grantable,
      rules: [...first.rules, ...second.rules],
    };
  }
  const narrower = narrowest(first.decision, second.decision) === first.decision ? first : second;
  return {
    ...narrower,
    targets: first.targets,
    grantIds: narrower.decision === "allow" ? [...new Set([...first.grantIds, ...second.grantIds])] : narrower.grantIds,
  };
};

/**
 * Copies a repository Git made in the hub's own `staging` folder to `.git` in the hob's folder, run
 * in its own process. It enters the hob's canonical folder `root` and each level below it, making
 * those missing, and checks after every step where it really landed, so a link anywhere is refused
 * and a folder swapped for one meanwhile changes nothing for it. It then makes `.git`, failing when
 * anything has that name, and copies each folder and file by name inside it, never over anything a
 * command wrote there first; anything else that appears there meanwhile fails the call. With `kept`,
 * the source of `KEPT`, a stub `.git` is removed first, by name and never through a link, stopping
 * at any file it does not name. Arguments, as JSON: `root`, the levels, `staging` and `kept` or null.
 */
export const PUBLISH_SCRIPT = `
const fs = require("node:fs");
const { join } = require("node:path");
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const [root, levels, staging, kept] = JSON.parse(process.argv[1]);
const keeps = kept === null ? null : new RegExp(kept);
const stop = (code, message) => { process.stdout.write(message); process.exit(code); };
const enter = (name, expected) => {
  process.chdir(name);
  if (process.cwd() !== expected) stop(3, expected + " moved while Hobbots was creating the repository.");
};
// Walks a stub .git, entered at here, by name and never through a link, stopping at any file the kept
// pattern does not name; with remove, it removes each file and folder as it goes.
const clear = (here, path, remove) => {
  for (const entry of fs.readdirSync(".", { withFileTypes: true })) {
    const inner = path + entry.name;
    if (entry.isDirectory()) {
      enter(entry.name, join(here, entry.name));
      clear(join(here, entry.name), inner + "/", remove);
      enter("..", here);
      if (remove) fs.rmdirSync(entry.name);
    } else if (!keeps.test(inner)) {
      stop(4, here + " holds " + inner + (remove ? ", written while Hobbots was replacing its .git." : ", so its .git was left as it is."));
    }
    else if (remove) fs.unlinkSync(entry.name);
  }
};
const copy = (from, here) => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const mode = fs.statSync(source).mode & 0o777;
    if (entry.isDirectory()) {
      fs.mkdirSync(entry.name, mode);
      enter(entry.name, join(here, entry.name));
      copy(source, join(here, entry.name));
      enter("..", here);
    } else if (entry.isFile()) {
      const file = fs.openSync(entry.name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
      try { fs.writeFileSync(file, fs.readFileSync(source)); } finally { fs.closeSync(file); }
    }
  }
};
try {
  let here = root;
  enter(root, root);
  for (const level of levels) {
    if (fs.lstatSync(level, { throwIfNoEntry: false }) === undefined) fs.mkdirSync(level);
    here = join(here, level);
    enter(level, here);
  }
  if (keeps !== null && fs.lstatSync(".git", { throwIfNoEntry: false })?.isDirectory()) {
    enter(".git", join(here, ".git"));
    clear(join(here, ".git"), "", false);
    clear(join(here, ".git"), "", true);
    enter("..", here);
    fs.rmdirSync(".git");
  }
  try { fs.mkdirSync(".git"); } catch (error) {
    if (error.code === "EEXIST") stop(4, here + " already has a .git, so nothing was created.");
    throw error;
  }
  const git = join(here, ".git");
  enter(".git", git);
  copy(staging, git);
  const extra = fs.readdirSync(".").filter((name) => !fs.existsSync(join(staging, name)));
  if (extra.length > 0) stop(6, "Something else wrote " + extra.join(", ") + " in " + git + " while Hobbots was creating it.");
} catch (error) {
  stop(5, "Hobbots could not create the repository: " + (error.code ?? error.message));
}
`;

interface LocalGitOptions {
  /** A folder of the hub's own, which no hob's command reaches, where Git makes each repository first. */
  readonly stagingFolder: string;
}

export const LocalGitToolsLive = (options: LocalGitOptions) =>
  Layer.effect(
    LocalGitTools,
    Effect.gen(function* () {
      const engine = yield* PolicyEngine;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // The hub's own Git, outside any sandbox, only to read the user's `init.defaultBranch`.
      const git = runTool(spawner, toolEnv(process.env));
      const tool = {
        name: GIT_INIT_TOOL,
        description: GIT_INIT_DESCRIPTION,
        label: GIT_INIT_LABEL,
        inputSchema: gitInitToolJsonSchema(),
      };

      /**
       * Refuses a folder that is, or lies in, a Git directory, or already holds a `.git` other than a
       * stub, and answers whether a stub is there to replace.
       */
      const checkPlace = (folder: string) =>
        Effect.gen(function* () {
          if (insideGitDirectory(folder)) {
            return yield* new HubRefusal({
              message: `${folder} is inside a Git directory, so it cannot hold a repository.`,
            });
          }
          const git = yield* Effect.try({
            try: () => gitDirectory(folder),
            catch: (error) =>
              new HubRefusal({
                message: `Hobbots could not read ${folder}, so nothing was created: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
              }),
          });
          if (git._tag === "Repository") {
            return yield* new HubRefusal({
              message: `${folder} is already a Git repository, so nothing was created. Commit in it with git as usual.`,
            });
          }
          if (git._tag === "Other") {
            const named = git.other.slice(0, 5).map((path) => `.git/${path.split(sep).join("/")}`);
            const more = git.other.length > named.length ? " and the rest of it" : "";
            return yield* new HubRefusal({
              message: `${folder} holds a .git that is not a repository, so nothing was created. Delete ${named.join(", ")}${more}, then call ${GIT_INIT_TOOL} again: it replaces a .git that holds only a config and hooks.`,
            });
          }
          return git._tag === "Stub";
        });

      /**
       * The call's requests: Local Git on the folder, and Edit files on it, since the hub writes the
       * repository's files there for the hob (STD-SEC-002). Edit files is decided on the folder, not
       * its `.git`, which the policy keeps from every hob's own writes. In place of a stub, it is
       * decided on the new `HEAD`, since the folder holds the stub's config and hooks, which no hob
       * may change and which only the hub removes.
       */
      const requestFor = (folder: string, replace: boolean): GitInitRequest => ({
        _tag: "GitInit",
        command: { _tag: "Command", operation: "local-git", cwd: folder, words: ["git", "init"] },
        files: {
          _tag: "Files",
          operation: "edit-files",
          paths: [replace ? join(folder, ".git", "HEAD") : folder],
          cwd: folder,
        },
      });

      /** The canonical hob folder that holds `target`, which the sandboxed `git init` may write below. */
      const holder = (access: ToolAccess, target: string) =>
        access.folders.map(canonical).find((folder) => target === folder || target.startsWith(`${folder}${sep}`));

      /** The user's `init.defaultBranch`, read from their own Git config on the hub, when it is a plain name. */
      const initialBranch = git("git", ["config", "--global", "--get", "init.defaultBranch"]).pipe(
        Effect.map((run) => run.out.trim()),
        Effect.map((name) => (BRANCH_NAME.test(name) ? name : null)),
        Effect.orElseSucceed(() => null),
      );

      /**
       * Creates the repository at `target`, below the hob's canonical folder `writable`: Git makes it in
       * the hub's staging folder, outside every hob's reach and with no config of the user's, and
       * `PUBLISH_SCRIPT` copies it to `target`'s `.git` without following links.
       */
      const create = (writable: string, target: string, replace: boolean) =>
        Effect.gen(function* () {
          const branch = yield* initialBranch;
          mkdirSync(options.stagingFolder, { recursive: true, mode: 0o700 });
          const staging = mkdtempSync(join(options.stagingFolder, "init-"));
          const ownGit = runTool(spawner, {
            PATH: process.env.PATH,
            HOME: options.stagingFolder,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          });
          const node = runTool(spawner, { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" });
          const levels = target === writable ? [] : relative(writable, target).split(sep);
          return yield* Effect.gen(function* () {
            const made = yield* ownGit("git", [
              "init",
              "--quiet",
              "--template=",
              ...(branch === null ? [] : [`--initial-branch=${branch}`]),
              "--",
              staging,
            ]);
            if (made.code !== 0) {
              return yield* new HubRefusal({ message: `Git could not create the repository: ${made.out.trim()}` });
            }
            const published = yield* node(process.execPath, [
              "-e",
              PUBLISH_SCRIPT,
              JSON.stringify([writable, levels, join(staging, ".git"), replace ? KEPT.source : null]),
            ]);
            if (published.code !== 0) return yield* new HubRefusal({ message: published.out.trim() });
          }).pipe(
            Effect.mapError((error) =>
              error === "unavailable"
                ? new HubRefusal({ message: "Git did not finish on the hub, so no repository was created." })
                : error,
            ),
            Effect.ensuring(Effect.sync(() => rmSync(staging, { recursive: true, force: true }))),
          );
        });

      const actions = makeHubActions({
        owner: { _tag: "BuiltIn" },
        actions: [
          hubAction({
            tool,
            input: GitInitInput,
            effect: "write",
            otherwise: "there is nowhere to create a repository",
            invalid: "Give the folder to make a repository, as an absolute path.",
            plan: ({ folder }, { access }) =>
              Effect.gen(function* () {
                if (access.folders.length === 0) {
                  return yield* new HubRefusal({
                    message: "You have no folders this turn, so there is nowhere to create a repository.",
                  });
                }
                if (!isAbsolute(folder)) {
                  return yield* new HubRefusal({ message: `Give the folder as an absolute path, not ${folder}.` });
                }
                const stub = yield* checkPlace(folder);
                return {
                  request: requestFor(folder, stub),
                  card: { arguments: { folder } },
                  send: ({ targets }) =>
                    Effect.gen(function* () {
                      // The folder as the engine resolved it, links followed, so the repository goes where it was decided.
                      const target = targets[0] ?? folder;
                      const replace = target === folder ? stub : yield* checkPlace(target);
                      const writable = holder(access, target);
                      if (writable === undefined) {
                        return yield* new HubRefusal({
                          message: `${target} is outside this hob's folders, so nothing was created.`,
                        });
                      }
                      yield* create(writable, target, replace);
                      return createdText(target, replace, writable === target);
                    }),
                };
              }),
          }),
        ],
        // The narrower answer of the two stands, on the folder.
        decide: (approvals, base, request: GitInitRequest) => (fresh) =>
          Effect.gen(function* () {
            const git = yield* decideHubCall(engine, approvals, base, request.command)(fresh);
            const edit = yield* decideHubCall(engine, approvals, base, request.files)(fresh);
            return narrowerOf(git, edit);
          }),
      });

      return LocalGitTools.of({
        // Offered only where its access opens it, by the rule a delegation announces it by (#699).
        forTurn: (turn) =>
          Effect.map(turn.currentAccess, (access) =>
            access === null ||
            access.folders.length === 0 ||
            !openTools((operation) => operationDecision(access.policy, operation)).gitInit
              ? null
              : actions(turn),
          ),
      });
    }),
  );
