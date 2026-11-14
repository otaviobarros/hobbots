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
 * Why a call's writes are refused (#1449): the first path or branch it writes that you took over
 * from a Task, which is yours until the Task ends. Every hob's call is checked, whatever Task it
 * works on, so no other hob writes there either. Paths are matched inside the repository by its
 * identity, so another clone or worktree of it is refused too. Null when nothing it writes is yours,
 * or when the hub keeps no claims register.
 */
/**
 * Whether a write at `inside` touches the taken path `key`, without regard to case, as a
 * case-insensitive volume reads `DOCS` and `docs` as one folder; on a case-sensitive one this
 * refuses at most a few writes too many.
 */
const touchesKey = (key: string, inside: string) =>
  touchesPath({ scope: "path", key: key.toLowerCase() }, inside.toLowerCase());

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
        // A taken path is matched as it was claimed and where it lands with its links followed, so
        // a claim on `docs`, a link to `content`, holds writes to either spelling.
        const followedKeys = new Map<string, ReadonlyArray<string>>();
        const keysOf = (top: string, key: string) =>
          Effect.gen(function* () {
            const known = followedKeys.get(`${top}\0${key}`);
            if (known !== undefined) return known;
            const place = key === "" ? null : yield* git.placeOf(`${top}${separator}${key.split("/").join(separator)}`);
            const keys = place === null || place.top !== top || place.path === key ? [key] : [key, place.path];
            followedKeys.set(`${top}\0${key}`, keys);
            return keys;
          });
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
        const placeHit = (path: string, name = "") =>
          Effect.gen(function* () {
            const place = yield* git.placeOf(path);
            if (place === null) return undefined;
            const inside = name === "" ? place.path : place.path === "" ? name : `${place.path}/${name}`;
            for (const claim of yield* takenAt(place.top)) {
              const keys = claim.scope === "path" ? yield* keysOf(place.top, claim.key) : [];
              if (keys.some((key) => touchesKey(key, inside))) return claim;
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
        const treeHit = (cwd: string) =>
          atRepository(cwd, (_top, claims) =>
            Effect.succeed(claims.find((claim) => claim.scope === "path" || claim.scope === "branch")),
          );

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
