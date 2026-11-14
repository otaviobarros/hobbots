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

        for (const path of writes.paths) {
          const place = yield* git.placeOf(path);
          if (place === null) continue;
          const hit = (yield* takenAt(place.top)).find((claim) => touchesPath(claim, place.path));
          if (hit !== undefined) return takenWriteText(hit);
        }
        for (const push of writes.pushes) {
          const top = yield* git.repository(push.cwd);
          if (top === null) continue;
          const claims = yield* takenAt(top);
          const target = pushTarget(push.branch);
          // A push whose words do not name its branches, such as `git push --all`, may reach any
          // branch, so any branch you took over in the repository refuses it.
          const hit =
            target._tag === "Unnamed"
              ? claims.find((claim) => claim.scope === "branch")
              : branchClaim(claims, target._tag === "Current" ? yield* git.currentBranch(top) : target.name);
          if (hit !== undefined) return takenWriteText(hit);
        }
        for (const cwd of writes.commits) {
          const top = yield* git.repository(cwd);
          if (top === null) continue;
          const hit = branchClaim(yield* takenAt(top), yield* git.currentBranch(top));
          if (hit !== undefined) return takenWriteText(hit);
        }
        return null;
      });
  });
