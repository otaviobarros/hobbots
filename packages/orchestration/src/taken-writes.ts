import { type CallWrites, ClaimRegister, GitWorkspace, MemoryProjects } from "@hobbots/agents";
import { type Claim, claimBranch, memoryProjectIdentity, takenWriteText, touchesPath } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { PathSeparator } from "./authority.ts";

/** The last name of a folder, which a repository with no `origin` remote is known by. */
const lastName = (folder: string, separator: PathSeparator) =>
  folder
    .split(separator)
    .filter((name) => name !== "")
    .at(-1) ?? folder;

/**
 * Who a repository is across clones and worktrees, from its top folder: its normalized `origin`
 * remote, or its folder's name. Claims are keyed by it (ADR 037).
 */
export const makeRepositoryIdentity = (separator: PathSeparator) =>
  Effect.map(
    Effect.serviceOption(MemoryProjects),
    (projects) =>
      (top: string): Effect.Effect<string> =>
        Option.isSome(projects)
          ? projects.value.of(top)
          : Effect.succeed(memoryProjectIdentity(null, lastName(top, separator))),
  );

/**
 * Where `path` inside the repository at `inner` lies inside the repository at `top`, when `inner`
 * is a folder of it, as a repository nested in another is; null otherwise.
 */
const below = (top: string, inner: string, path: string, separator: PathSeparator) => {
  if (!inner.startsWith(`${top}${separator}`)) return null;
  return joinedInside(
    inner
      .slice(top.length + 1)
      .split(separator)
      .join("/"),
    path,
  );
};

/** Two paths inside a repository joined, where "" is its top folder. */
const joinedInside = (folder: string, path: string) =>
  folder === "" ? path : path === "" ? folder : `${folder}/${path}`;

/**
 * A taken path's keys inside the repository at `top`: as it was claimed and where it lands with its
 * links followed, so a claim on `docs`, a link to `content`, holds writes to either spelling. Each
 * is read once per use of the function.
 */
const makeKeysOf = (git: GitWorkspace["Service"], separator: PathSeparator) => {
  const followedKeys = new Map<string, ReadonlyArray<string>>();
  return (top: string, key: string) =>
    Effect.gen(function* () {
      const known = followedKeys.get(`${top}\0${key}`);
      if (known !== undefined) return known;
      const place = key === "" ? null : yield* git.placeOf(`${top}${separator}${key.split("/").join(separator)}`);
      // A link may land in a repository inside this one: its target is then read from this top.
      const landed =
        place === null ? null : place.top === top ? place.path : below(top, place.top, place.path, separator);
      const keys = landed === null || landed === key ? [key] : [key, landed];
      followedKeys.set(`${top}\0${key}`, keys);
      return keys;
    });
};

/** Pushes whose words name the checked-out branch, as the runtimes' Push requests spell them. */
const CURRENT_BRANCH = new Set(["(current branch)", "(HEAD)", "(@)", "(+HEAD)", "(+@)"]);

type PushTarget =
  | { readonly _tag: "Branch"; readonly name: string }
  | { readonly _tag: "Current" }
  | { readonly _tag: "Unnamed" };

/**
 * The branch a Push request names: a branch, the checked-out one, or none when the push does
 * not say, as the runtimes write `(several branches)` for `git push --all` or `(refs/heads/*)`.
 */
const pushTarget = (branch: string): PushTarget => {
  if (CURRENT_BRANCH.has(branch)) return { _tag: "Current" };
  const name = branch.startsWith("(") ? null : claimBranch(branch);
  return name === null ? { _tag: "Unnamed" } : { _tag: "Branch", name };
};

/**
 * Whether a write at `inside` touches the taken path `key`, without regard to case, as a
 * case-insensitive volume reads `DOCS` and `docs` as one folder; on a case-sensitive one this
 * refuses at most a few writes too many.
 */
const touchesKey = (key: string, inside: string) =>
  touchesPath({ scope: "path", key: key.toLowerCase() }, inside.toLowerCase());

/**
 * Why a call's writes are refused (#1449): the first path or branch it writes that you took over
 * from a Task, which is yours until you give it back or the Task ends. Every hob's call is checked, whatever Task it
 * works on, so no other hob writes there either. Paths are matched inside the repository by its
 * identity, so another clone or worktree of it is refused too. Null when nothing it writes is yours,
 * or when the hub keeps no claims register.
 */
export const makeTakenWrites = (separator: PathSeparator) =>
  Effect.gen(function* () {
    const register = yield* Effect.serviceOption(ClaimRegister);
    const workspace = yield* Effect.serviceOption(GitWorkspace);
    const identityOf = yield* makeRepositoryIdentity(separator);

    return (writes: CallWrites): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        if (Option.isNone(register) || Option.isNone(workspace)) return null;
        const git = workspace.value;
        // Each repository's claims are read once for the call.
        const read = new Map<string, ReadonlyArray<Claim>>();
        const takenAt = (top: string) =>
          Effect.gen(function* () {
            const repository = yield* identityOf(top);
            const known = read.get(repository);
            if (known !== undefined) return known;
            const claims = yield* register.value.takenIn(repository);
            read.set(repository, claims);
            return claims;
          });
        const keysOf = makeKeysOf(git, separator);
        const branchClaim = (claims: ReadonlyArray<Claim>, branch: string | null) =>
          branch === null ? undefined : claims.find((claim) => claim.scope === "branch" && claim.key === branch);

        const atRepository = (
          cwd: string,
          pick: (top: string, claims: ReadonlyArray<Claim>) => Effect.Effect<Claim | undefined>,
        ) =>
          Effect.gen(function* () {
            const top = yield* git.repository(cwd);
            return top === null ? undefined : yield* pick(top, yield* takenAt(top));
          });
        // A repository inside another, such as a submodule, is also a folder of the one around it, so
        // a write there is checked against the claims of every repository it lies in.
        const placeHit = (path: string, name = "") =>
          Effect.gen(function* () {
            let place = yield* git.placeOf(path);
            let inside = place === null ? "" : joinedInside(place.path, name);
            while (place !== null) {
              for (const claim of yield* takenAt(place.top)) {
                const keys = claim.scope === "path" ? yield* keysOf(place.top, claim.key) : [];
                if (keys.some((key) => touchesKey(key, inside))) return claim;
              }
              const at = place.top.lastIndexOf(separator);
              if (at <= 0) return undefined;
              const outer = yield* git.placeOf(place.top.slice(0, at));
              if (outer === null || outer.top.length >= place.top.length) return undefined;
              inside = joinedInside(joinedInside(outer.path, lastName(place.top, separator)), inside);
              place = outer;
            }
            return undefined;
          });
        // A path is checked where it lands with its links followed, and as the entry it names in its
        // folder, so deleting a link inside a taken folder is refused though its target is not.
        const pathHit = (path: string) =>
          Effect.gen(function* () {
            const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf(separator));
            const name = path.slice(at + 1);
            const entry =
              at > 0 && name !== "" && name !== "." && name !== ".." ? placeHit(path.slice(0, at), name) : undefined;
            return (yield* placeHit(path)) ?? (entry === undefined ? undefined : yield* entry);
          });
        // A push whose words do not name its branches, such as `git push --all`, may reach any
        // branch, so any branch you took over in the repository refuses it.
        const pushHit = (push: CallWrites["pushes"][number]) =>
          atRepository(push.cwd, (top, claims) => {
            const target = pushTarget(push.branch);
            if (target._tag === "Unnamed") return Effect.succeed(claims.find((claim) => claim.scope === "branch"));
            if (target._tag === "Branch") return Effect.succeed(branchClaim(claims, target.name));
            return Effect.map(git.currentBranch(top), (branch) => branchClaim(claims, branch));
          });
        const commitHit = (cwd: string) =>
          atRepository(cwd, (top, claims) =>
            Effect.map(git.currentBranch(top), (branch) => branchClaim(claims, branch)),
          );
        // A command that may rewrite the working tree or move a branch, such as `git reset --hard` or
        // `git switch` before a commit in the same call, may reach any file or branch in it, so
        // anything you took over in the repository refuses it.
        // In a repository inside another, its whole tree is a folder of the outer one, so the outer
        // repositories' taken paths are checked against it too.
        const treeHit = (cwd: string) =>
          atRepository(cwd, (top, claims) => {
            const own = claims.find((claim) => claim.scope === "path" || claim.scope === "branch");
            return own === undefined ? placeHit(top) : Effect.succeed(own);
          });

        const checks = [
          ...writes.paths.map(pathHit),
          ...writes.pushes.map(pushHit),
          ...writes.commits.map(commitHit),
          ...writes.trees.map(treeHit),
        ];
        for (const check of checks) {
          const hit = yield* check;
          if (hit !== undefined) return takenWriteText(hit);
        }
        return null;
      });
  });

/**
 * What a hob's turn may not write at all, because you took it over from a Task (#1537): for every
 * repository its folders reach, and every repository around those, each taken path by absolute
 * path, as claimed and where its links land, and the whole ref store of a repository with a taken
 * branch, so no branch there moves. The turn's sandbox closes them, so a write the call-level check
 * cannot see, from a script, a variable, an interpreter or Git's own config, fails too. Every hob's turn gets them, whatever Task it works
 * on. Empty when nothing is taken there, or when the hub keeps no claims register.
 */
export const makeTakenPlaces = (separator: PathSeparator) =>
  Effect.gen(function* () {
    const register = yield* Effect.serviceOption(ClaimRegister);
    const workspace = yield* Effect.serviceOption(GitWorkspace);
    const identityOf = yield* makeRepositoryIdentity(separator);
    if (Option.isNone(register) || Option.isNone(workspace)) {
      return (_folders: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>> => Effect.succeed([]);
    }
    const git = workspace.value;
    const claims = register.value;

    // A repository inside another is a folder of it, whose taken paths may hold it.
    const withOuter = (top: string, tops: Set<string>) =>
      Effect.gen(function* () {
        let at: string | null = top;
        while (at !== null && !tops.has(at)) {
          tops.add(at);
          const up = at.lastIndexOf(separator);
          const outer: string | null = up <= 0 ? null : yield* git.repository(at.slice(0, up));
          at = outer !== null && outer.length < at.length ? outer : null;
        }
      });
    // What one taken claim closes in the repository at `top`.
    const closedBy = (top: string, claim: Claim, keysOf: ReturnType<typeof makeKeysOf>) =>
      claim.scope === "path"
        ? Effect.map(keysOf(top, claim.key), (keys) =>
            keys.map((key) => (key === "" ? top : `${top}${separator}${key.split("/").join(separator)}`)),
          )
        : claim.scope === "branch"
          ? // No branch of the repository moves while one is taken: its whole ref store is closed.
            git.refStores(top)
          : Effect.succeed([]);

    return (folders: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function* () {
        const tops = new Set<string>();
        const closed = new Set<string>();
        for (const folder of folders) {
          const reached = yield* git.repositoriesIn(folder);
          for (const top of reached.tops) yield* withOuter(top, tops);
          // A folder too big to scan whole may hold a repository with something taken: closed whole.
          if (!reached.complete && (yield* claims.anyTaken)) closed.add(folder);
        }
        const keysOf = makeKeysOf(git, separator);
        for (const top of tops) {
          for (const claim of yield* claims.takenIn(yield* identityOf(top))) {
            for (const path of yield* closedBy(top, claim, keysOf)) closed.add(path);
          }
        }
        return [...closed].sort();
      });
  });
