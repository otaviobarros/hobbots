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
        const pathHit = (path: string) =>
          Effect.gen(function* () {
            const place = yield* git.placeOf(path);
            return place === null
              ? undefined
              : (yield* takenAt(place.top)).find((claim) => touchesPath(claim, place.path));
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
        // A command that rewrites the working tree, such as `git reset --hard`, may reach any file in
        // it, so any path you took over in the repository refuses it.
        const treeHit = (cwd: string) =>
          atRepository(cwd, (_top, claims) => Effect.succeed(claims.find((claim) => claim.scope === "path")));

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
