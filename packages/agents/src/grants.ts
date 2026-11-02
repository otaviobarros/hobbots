import { GrantNotFound, UserSession } from "@hobbots/api";
import {
  type AgentId,
  type ApprovalRequest,
  type Committed,
  type Grant,
  type GrantId,
  type GrantRevokeReason,
  type GrantRule,
  type HobPolicy,
  isLiveGrant,
  isNarrowerOrEqual,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type PolicyOperation,
  PRESET_DECISIONS,
  ruleOperation,
  type SafetyPreset,
  stableJson,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Semaphore } from "effect";
import { EventPublisher } from "./ports.ts";
import type { ToolAccess } from "./runtime.ts";

/** Where grants are stored. Grants are created with the decision that saves them (`ApprovalRepository`). */
export class GrantRepository extends Context.Service<
  GrantRepository,
  {
    readonly find: (id: GrantId) => Effect.Effect<Option.Option<Grant>>;
    /** Every grant, or one hob's, oldest first, revoked ones included. */
    readonly list: (agentId?: AgentId) => Effect.Effect<ReadonlyArray<Grant>>;
    /** The grants a decision saved. */
    readonly forApproval: (approvalId: ApprovalRequest["id"]) => Effect.Effect<ReadonlyArray<Grant>>;
    /**
     * Saves `next`'s revocation with its GrantRevoked event. None, and nothing changed, when the
     * grant was already revoked.
     */
    readonly revoke: (next: Grant) => Effect.Effect<Option.Option<Committed<Grant>>>;
    /** Records when the grants last answered a call. Not journaled: it changes no decision. */
    readonly touch: (ids: ReadonlyArray<GrantId>, at: string) => Effect.Effect<void>;
  }
>()("@hobbots/agents/GrantRepository") {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const sep = "/";

/** Whether a canonical path is the folder or inside it. */
const within = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

const parentOf = (path: string) => {
  const index = path.lastIndexOf(sep);
  return index <= 0 ? sep : path.slice(0, index);
};

/** The folders and files a rule relies on being in the hob's folders. */
const rulePaths = (rule: GrantRule): ReadonlyArray<string> => {
  switch (rule._tag) {
    case "Folder":
      return [rule.folder];
    case "Paths":
      return rule.paths;
    case "Command":
    case "Push":
    case "PullRequest":
    case "GitHubComment":
      return [rule.cwd];
    case "Host":
      return [];
  }
};

/**
 * Whether `rule` is one the request offered, or a narrowing the card allows (ADR 015): a folder rule
 * narrowed to the exact files of the call. Anything else would let a client save more than it showed.
 */
export const ruleOffered = (approval: ApprovalRequest, rule: GrantRule): boolean => {
  const key = stableJson(rule);
  if (approval.rules.some((offered) => stableJson(offered) === key)) return true;
  if (rule._tag !== "Paths" || rule.paths.length === 0) return false;
  return rule.paths.every(
    (path) =>
      approval.targets.includes(path) &&
      approval.rules.some(
        (offered) =>
          (offered._tag === "Folder" || offered._tag === "Paths") &&
          offered.operation === rule.operation &&
          ((offered._tag === "Folder" && parentOf(path) === offered.folder) ||
            (offered._tag === "Paths" && offered.paths.includes(path))),
      ),
  );
};

/**
 * Whether the hob's access now still gives a rule the authority it relies on (ADR 015): only the
 * preset asks for its operation, no override or restriction asks or answers Never, and its folders
 * are still the hob's. A decision checks this as it saves, so a grant never outlives a narrowing.
 */
export const ruleHolds = (access: ToolAccess | null, rule: GrantRule): boolean => {
  if (access === null) return false;
  const operation = ruleOperation(rule);
  const { preset, hob, restrictions } = access.policy;
  if (PRESET_DECISIONS[preset][operation] !== "ask") return false;
  const layers = [hob.overrides[operation], ...restrictions.map((restriction) => restriction[operation])];
  if (layers.some((decision) => decision !== undefined && decision !== "allow")) return false;
  return rulePaths(rule).every((path) => access.folders.some((folder) => within(path, folder)));
};

/** What a change took away: folders that left the hob's folders, and operations narrowed to Ask or Never. */
export interface AuthorityLoss {
  readonly folders: ReadonlyArray<string>;
  readonly operations: ReadonlyArray<PolicyOperation>;
}

/** Why a grant no longer holds after the change, or null when it still does (ADR 015). */
export const lostAuthority = (grant: Grant, loss: AuthorityLoss): GrantRevokeReason | null => {
  if (loss.operations.includes(grant.operation)) return "narrowed";
  const paths = rulePaths(grant.rule);
  return paths.some((path) => loss.folders.some((folder) => within(path, folder))) ? "folder-removed" : null;
};

/** Whether an answer moved to Ask or Never from a wider one. */
const narrowedTo = (before: PolicyDecision | undefined, after: PolicyDecision | undefined) =>
  after !== undefined &&
  after !== "allow" &&
  after !== before &&
  (before === undefined || isNarrowerOrEqual(after, before));

/** What a hob's policy change takes away: folders removed or hidden, and overrides narrowed to Ask or Never. */
export const policyLoss = (before: HobPolicy, after: HobPolicy): AuthorityLoss => ({
  folders: [
    ...before.ownFolders.filter((folder) => !after.ownFolders.includes(folder)),
    ...after.hiddenSharedFolders.filter((folder) => !before.hiddenSharedFolders.includes(folder)),
  ],
  operations: POLICY_OPERATIONS.filter((operation) =>
    narrowedTo(before.overrides[operation], after.overrides[operation]),
  ),
});

/** What a setup change takes away from every hob: shared folders removed, and the preset narrowed to Ask or Never. */
export const setupLoss = (
  before: { readonly safetyPreset: SafetyPreset; readonly approvedFolders: ReadonlyArray<string> },
  after: { readonly safetyPreset: SafetyPreset; readonly approvedFolders: ReadonlyArray<string> },
): AuthorityLoss => ({
  folders: before.approvedFolders.filter((folder) => !after.approvedFolders.includes(folder)),
  operations: POLICY_OPERATIONS.filter((operation) =>
    narrowedTo(PRESET_DECISIONS[before.safetyPreset][operation], PRESET_DECISIONS[after.safetyPreset][operation]),
  ),
});

/**
 * Standing grants (ADR 015, PE-007, PE-008): listing them, the user removing one, and the hub
 * revoking those whose authority a change took away. A revoked grant is kept, never deleted, and
 * the next matching call asks again.
 */
export class GrantService extends Context.Service<
  GrantService,
  {
    /** The hob's grants that apply now: not revoked and not expired. */
    readonly live: (agentId: AgentId) => Effect.Effect<ReadonlyArray<Grant>>;
    /** Grants oldest first, optionally one hob's; with `all`, revoked and expired ones too. */
    readonly list: (options: {
      readonly agentId?: AgentId | undefined;
      readonly all?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<Grant>>;
    /**
     * The user removes a grant. Removing it again returns it unchanged. `then` runs only when this
     * call revoked it, such as stopping the hob's running turns for a host grant, and, like saving
     * the revocation, is not interrupted once begun. Only the user removes a grant (PE-006): it needs
     * a `UserSession`, which no hob, Charm or runtime tool has.
     */
    readonly revoke: (
      id: GrantId,
      then?: (grant: Grant) => Effect.Effect<void>,
    ) => Effect.Effect<Grant, GrantNotFound, UserSession>;
    /** Revokes the grants, of one hob or all, that the change took authority from. */
    readonly revokeLost: (agentId: AgentId | null, loss: AuthorityLoss) => Effect.Effect<void>;
    /** Revokes every grant of a hob that retired. */
    readonly revokeForAgent: (agentId: AgentId, reason: GrantRevokeReason) => Effect.Effect<void>;
    readonly used: (ids: ReadonlyArray<GrantId>) => Effect.Effect<void>;
    /**
     * Runs `effect` while no revocation for a change runs, so a grant saved inside it is either seen
     * by the revocation that follows a change, or saved after checking the authority as changed.
     */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@hobbots/agents/GrantService") {
  static readonly layer = Layer.effect(
    GrantService,
    Effect.gen(function* () {
      const repo = yield* GrantRepository;
      const bus = yield* EventPublisher;
      // Saving grants and revoking them for a change take turns (see `exclusive`).
      const lock = yield* Semaphore.make(1);

      const liveOf = (grants: ReadonlyArray<Grant>) =>
        Effect.map(nowIso, (now) => grants.filter((grant) => isLiveGrant(grant, now)));

      const end = (grant: Grant, by: "user" | "hub", reason: GrantRevokeReason) =>
        Effect.gen(function* () {
          const next = { ...grant, revokedAt: yield* nowIso, revokedBy: by, revokeReason: reason } as Grant;
          const saved = yield* repo.revoke(next);
          if (Option.isNone(saved)) return Option.none<Grant>();
          yield* bus.publish(saved.value.entries);
          return Option.some(saved.value.value);
        });

      const revokeWhere = (agentId: AgentId | null, reasonOf: (grant: Grant) => GrantRevokeReason | null) =>
        Semaphore.withPermit(
          lock,
          Effect.gen(function* () {
            const grants = yield* liveOf(yield* repo.list(agentId ?? undefined));
            for (const grant of grants) {
              const reason = reasonOf(grant);
              if (reason !== null) yield* end(grant, "hub", reason);
            }
          }),
        );

      return GrantService.of({
        live: (agentId) => Effect.flatMap(repo.list(agentId), liveOf),
        list: ({ agentId, all }) =>
          Effect.flatMap(repo.list(agentId), (grants) => (all === true ? Effect.succeed(grants) : liveOf(grants))),
        revoke: (id, then) =>
          Effect.gen(function* () {
            yield* UserSession;
            const found = yield* repo.find(id);
            if (Option.isNone(found)) return yield* new GrantNotFound({ grantId: id });
            if (found.value.revokedAt !== null) return found.value;
            // Once saved, a revocation is never retried, so what follows it runs to the end even when
            // the request is cancelled, such as by the client disconnecting.
            const revoked = yield* Effect.uninterruptible(
              Effect.tap(end(found.value, "user", "removed"), (saved) =>
                Option.isSome(saved) && then ? then(saved.value) : Effect.void,
              ),
            );
            // Revoked meanwhile by a change: return it as it is now.
            return Option.isSome(revoked) ? revoked.value : Option.getOrElse(yield* repo.find(id), () => found.value);
          }),
        revokeLost: (agentId, loss) =>
          loss.folders.length === 0 && loss.operations.length === 0
            ? Effect.void
            : revokeWhere(agentId, (grant) => lostAuthority(grant, loss)),
        revokeForAgent: (agentId, reason) => revokeWhere(agentId, () => reason),
        exclusive: (effect) => Semaphore.withPermit(lock, effect),
        used: (ids) => (ids.length === 0 ? Effect.void : Effect.flatMap(nowIso, (at) => repo.touch(ids, at))),
      });
    }),
  );
}
