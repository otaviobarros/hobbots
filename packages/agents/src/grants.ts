import { type DeviceRevoked, GrantNotFound, UserSession } from "@hobbots/api";
import {
  type AgentId,
  type AnyOperation,
  type ApprovalRequest,
  type CharmDeclaration,
  type CharmId,
  type CharmOperation,
  type Committed,
  type Grant,
  type GrantId,
  type GrantRevokeReason,
  type GrantRule,
  type HobPolicy,
  hobAnswers,
  isCharmOperation,
  isLiveGrant,
  isNarrowerOrEqual,
  POLICY_OPERATIONS,
  type PolicyDecision,
  PRESET_DECISIONS,
  presetDecision,
  ruleOperation,
  type SafetyPreset,
  stableJson,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Semaphore } from "effect";
import { unguarded, type WriteGuard } from "./devices.ts";
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

/**
 * Whether a rule allows a call `charm` makes as its identity, so a grant of it belongs to one
 * identity (ADR 022, ADR 031): one of the Charm's operations it declares `actsAsIdentity`, or a
 * built-in operation it takes over, such as Push for the GitHub Charm.
 */
export const actsAsIdentity = (charm: CharmDeclaration, rule: GrantRule): boolean =>
  rule._tag === "CharmSite"
    ? rule.charm === charm.id &&
      charm.operations.some((operation) => operation.id === rule.operation && operation.actsAsIdentity)
    : charm.takesOver.some((operation) => operation === ruleOperation(rule));

/**
 * The Charms the hub holds, as they declare themselves to the policy (ADR 031). The hub's composition
 * provides them; without it no Charm operation is declared, so every Charm call stays closed.
 */
export const CharmDeclarations = Context.Reference<ReadonlyArray<CharmDeclaration>>(
  "@hobbots/agents/CharmDeclarations",
  { defaultValue: () => [] },
);

/**
 * The identity of a Charm a call was pinned to when it chose its credential (ADR 022), as
 * `GrantService.identity` counted it then. A request the call asks records it, rather than the
 * identity when the request is stored, so a call that began as one identity never asks as the other.
 */
export const CharmIdentityPin = Context.Reference<{
  readonly agentId: AgentId;
  readonly charm: CharmId;
  readonly identity: number;
} | null>("@hobbots/agents/CharmIdentityPin", { defaultValue: () => null });

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
      return [rule.cwd];
    case "CharmSite":
      return rule.cwd === undefined ? [] : [rule.cwd];
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
  const { preset, hob, restrictions, charmOperations = [] } = access.policy;
  if (presetDecision(preset, operation, charmOperations) !== "ask") return false;
  const layers = [hobAnswers(hob)[operation], ...restrictions.map((restriction) => restriction[operation])];
  if (layers.some((decision) => decision !== undefined && decision !== "allow")) return false;
  return rulePaths(rule).every((path) => access.folders.some((folder) => within(path, folder)));
};

/** What a change took away: folders that left the hob's folders, and operations narrowed to Ask or Never. */
export interface AuthorityLoss {
  readonly folders: ReadonlyArray<string>;
  readonly operations: ReadonlyArray<AnyOperation>;
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

/** The Charm operations either policy holds an override for. */
const charmOverridden = (before: HobPolicy, after: HobPolicy): ReadonlyArray<AnyOperation> =>
  [...new Set([...Object.keys(hobAnswers(before)), ...Object.keys(hobAnswers(after))])].filter(
    (operation): operation is AnyOperation => isCharmOperation(operation as AnyOperation),
  );

/** What a hob's policy change takes away: folders removed or hidden, and overrides narrowed to Ask or Never. */
export const policyLoss = (before: HobPolicy, after: HobPolicy): AuthorityLoss => {
  const was = hobAnswers(before);
  const is = hobAnswers(after);
  return {
    folders: [
      ...before.ownFolders.filter((folder) => !after.ownFolders.includes(folder)),
      ...after.hiddenSharedFolders.filter((folder) => !before.hiddenSharedFolders.includes(folder)),
    ],
    operations: [...POLICY_OPERATIONS, ...charmOverridden(before, after)].filter((operation) =>
      narrowedTo(was[operation], is[operation]),
    ),
  };
};

/**
 * What a setup change takes away from every hob: shared folders removed, and the preset narrowed to
 * Ask or Never, for a built-in operation or one of `charmOperations`.
 */
export const setupLoss = (
  before: { readonly safetyPreset: SafetyPreset; readonly approvedFolders: ReadonlyArray<string> },
  after: { readonly safetyPreset: SafetyPreset; readonly approvedFolders: ReadonlyArray<string> },
  charmOperations: ReadonlyArray<CharmOperation>,
): AuthorityLoss => ({
  folders: before.approvedFolders.filter((folder) => !after.approvedFolders.includes(folder)),
  operations: [
    ...POLICY_OPERATIONS.filter((operation) =>
      narrowedTo(PRESET_DECISIONS[before.safetyPreset][operation], PRESET_DECISIONS[after.safetyPreset][operation]),
    ),
    ...charmOperations
      .filter((operation) => narrowedTo(operation.presets[before.safetyPreset], operation.presets[after.safetyPreset]))
      .map((operation) => operation.id),
  ],
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
    ) => Effect.Effect<Grant, GrantNotFound | DeviceRevoked, UserSession>;
    /** Revokes the grants, of one hob or all, that the change took authority from. */
    readonly revokeLost: (agentId: AgentId | null, loss: AuthorityLoss) => Effect.Effect<void>;
    /** Revokes every grant of a hob that retired. */
    readonly revokeForAgent: (agentId: AgentId, reason: GrantRevokeReason) => Effect.Effect<void>;
    /**
     * Switches the identity `charm` acts as for the hob (ADR 022, ADR 031) with `change`, such as the
     * write that makes the hob act on GitHub as its own app or as the user. In one turn of the lock it
     * counts the change, revokes the hob's grants for what the Charm does as its identity (for GitHub:
     * Push, pull requests, comments), then runs `change`: no grant is saved between them, and none
     * allowed for one identity runs as the other.
     */
    readonly switchIdentity: <A, E, R>(
      charm: CharmDeclaration,
      agentId: AgentId,
      change: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /**
     * How many times the identity `charm` acts as for the hob changed since the hub started. A decision
     * saves a grant for a call made as that identity only while it is what it was when the call asking
     * chose its credential, checked inside `exclusive`, so no grant approved for one identity is saved
     * for the other. Read inside `exclusive` together with the credential, it names the identity that
     * credential is.
     */
    readonly identity: (charm: CharmId, agentId: AgentId) => Effect.Effect<number>;
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
      // Each hob's identity changes per Charm, counted under the lock (see `identity`).
      const identities = new Map<string, number>();
      const identityKey = (charm: CharmId, agentId: AgentId) => `${charm}\0${agentId}`;

      const liveOf = (grants: ReadonlyArray<Grant>) =>
        Effect.map(nowIso, (now) => grants.filter((grant) => isLiveGrant(grant, now)));

      // The user's removal is `guarded` by their device still being approved (ADR 021).
      const end = <X = never>(
        grant: Grant,
        by: "user" | "hub",
        reason: GrantRevokeReason,
        guarded: WriteGuard<X> = unguarded,
      ) =>
        Effect.gen(function* () {
          const next = { ...grant, revokedAt: yield* nowIso, revokedBy: by, revokeReason: reason } as Grant;
          const saved = yield* guarded(repo.revoke(next));
          if (Option.isNone(saved)) return Option.none<Grant>();
          yield* bus.publish(saved.value.entries);
          return Option.some(saved.value.value);
        });

      // Runs under the lock.
      const revokeEach = (agentId: AgentId | null, reasonOf: (grant: Grant) => GrantRevokeReason | null) =>
        Effect.gen(function* () {
          const grants = yield* liveOf(yield* repo.list(agentId ?? undefined));
          for (const grant of grants) {
            const reason = reasonOf(grant);
            if (reason !== null) yield* end(grant, "hub", reason);
          }
        });

      const revokeWhere = (agentId: AgentId | null, reasonOf: (grant: Grant) => GrantRevokeReason | null) =>
        Semaphore.withPermit(lock, revokeEach(agentId, reasonOf));

      return GrantService.of({
        live: (agentId) => Effect.flatMap(repo.list(agentId), liveOf),
        list: ({ agentId, all }) =>
          Effect.flatMap(repo.list(agentId), (grants) => (all === true ? Effect.succeed(grants) : liveOf(grants))),
        revoke: (id, then) =>
          Effect.gen(function* () {
            const session = yield* UserSession;
            const found = yield* repo.find(id);
            if (Option.isNone(found)) return yield* new GrantNotFound({ grantId: id });
            if (found.value.revokedAt !== null) return found.value;
            // Once saved, a revocation is never retried, so what follows it runs to the end even when
            // the request is cancelled, such as by the client disconnecting.
            const revoked = yield* Effect.uninterruptible(
              Effect.tap(end<DeviceRevoked>(found.value, "user", "removed", session.whileApproved), (saved) =>
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
        switchIdentity: (charm, agentId, change) =>
          Semaphore.withPermit(
            lock,
            Effect.gen(function* () {
              const key = identityKey(charm.id, agentId);
              identities.set(key, (identities.get(key) ?? 0) + 1);
              // GitHub is the only Charm with an identity yet, so the reason keeps its stored name.
              yield* revokeEach(agentId, (grant) => (actsAsIdentity(charm, grant.rule) ? "github-identity" : null));
              return yield* change;
            }),
          ),
        identity: (charm, agentId) => Effect.sync(() => identities.get(identityKey(charm, agentId)) ?? 0),
        exclusive: (effect) => Semaphore.withPermit(lock, effect),
        used: (ids) => (ids.length === 0 ? Effect.void : Effect.flatMap(nowIso, (at) => repo.touch(ids, at))),
      });
    }),
  );
}
