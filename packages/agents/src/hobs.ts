import {
  AgentNotFound,
  type CreateAgentPayload,
  InvalidFolder,
  InvalidHob,
  OverrideWidens,
  UndeclaredOperation,
  UnknownCharm,
  type UpdateAgentPayload,
  type UpdateHobPermissionsPayload,
} from "@hobbots/api";
import {
  Agent,
  AgentId,
  type ChangeActor,
  type CharmDeclaration,
  type CharmId,
  type CharmOperation,
  type CharmOverrides,
  DEFAULT_LENGTH,
  DEFAULT_VOICE,
  declaredOperations,
  type Effort,
  GOOD_AT_MAX,
  goodAtFromInstructions,
  type HobCharms,
  type HobPolicy,
  heldCharms,
  hobAnswers,
  hobBehind,
  holdsCharm,
  isNarrowerOrEqual,
  normalizeGoodAt,
  POLICY_OPERATIONS,
  PRESET_DECISIONS,
  type RoleId,
  RUNTIME_NAMES,
  type RuntimeKind,
  type RuntimeModels,
  type SafetyPreset,
  SUMMONING_CHARM_ID,
  starterRole,
  summoningDefaultsFor,
  summoningScopeOf,
  type TaskId,
  YOU,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission } from "./admission.ts";
import { sameFolderIn } from "./folders.ts";
import { CharmDeclarations } from "./grants.ts";
import { EventPublisher, FolderChecks, InstallationSettings } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { type RuntimeAdapters, runtimeAdapters } from "./runtime.ts";

/**
 * Checks a new hob's model and effort against what the runtime offers. A null model is the
 * runtime's default, so its effort is checked against the runtime's "default" entry when it lists one.
 */
export const checkBrain = (
  offered: RuntimeModels,
  brain: { readonly model: string | null; readonly effort: Effort | null },
): InvalidHob | undefined => {
  const model = offered.models.find((candidate) => candidate.id === (brain.model ?? "default"));
  if (brain.model !== null && model === undefined) {
    return new InvalidHob({ field: "model", message: `${offered.runtime} does not offer the model "${brain.model}"` });
  }
  if (brain.effort !== null && model !== undefined && !model.efforts.includes(brain.effort)) {
    return new InvalidHob({
      field: "effort",
      message:
        model.efforts.length === 0
          ? `${model.displayName} takes no effort setting`
          : `${model.displayName} accepts the efforts ${model.efforts.join(", ")}, not "${brain.effort}"`,
    });
  }
  return undefined;
};

/**
 * Checks a brain against the runtimes this hub serves and what its runtime offers (ADR 017): a
 * runtime with no adapter or no models, or a model or effort it does not offer, is refused.
 */
export const checkRuntimeBrain = (
  adapters: RuntimeAdapters,
  brain: { readonly runtime: RuntimeKind; readonly model: string | null; readonly effort: Effort | null },
): Effect.Effect<InvalidHob | undefined> => {
  const adapter = adapters(brain.runtime);
  if (adapter === undefined) {
    return Effect.succeed(
      new InvalidHob({ field: "runtime", message: `Hobbots cannot run ${RUNTIME_NAMES[brain.runtime]} on this hub` }),
    );
  }
  return Effect.map(adapter.models, (offered) =>
    // A runtime that offers no model, such as one not installed or not yet able to run turns, cannot think.
    offered.models.length === 0
      ? new InvalidHob({ field: "runtime", message: `${RUNTIME_NAMES[brain.runtime]} cannot think on this hub yet` })
      : checkBrain(offered, brain),
  );
};

/** The hob a lookup found, or `AgentNotFound` when there is none with this ID. */
export const foundAgent =
  (agentId: AgentId) =>
  (agent: Option.Option<Agent>): Effect.Effect<Agent, AgentNotFound> =>
    Option.match(agent, { onNone: () => Effect.fail(new AgentNotFound({ agentId })), onSome: Effect.succeed });

/** A starter role keeps its own title; a title in the user's own words goes with no role. */
export const checkRole = (role: {
  readonly role: RoleId | null;
  readonly roleTitle: string;
}): InvalidHob | undefined => {
  if (role.role === null) return undefined;
  const title = starterRole(role.role).title;
  return role.roleTitle === title
    ? undefined
    : new InvalidHob({ field: "roleTitle", message: `The ${title} role is titled "${title}"` });
};

/** Good at is one line that fits its limit once its whitespace is collapsed; a longer one is refused, never cut. */
export const checkGoodAt = (goodAt: string | null | undefined): InvalidHob | undefined =>
  goodAt != null && goodAt.length > GOOD_AT_MAX
    ? new InvalidHob({ field: "goodAt", message: `Good at is one line of up to ${GOOD_AT_MAX} characters` })
    : undefined;

/**
 * An override that would allow more than the preset, naming each operation it widens, built-in or a
 * Charm's (ADR 031).
 */
const checkOverrides = (
  preset: SafetyPreset,
  policy: HobPolicy,
  charmOperations: ReadonlyArray<CharmOperation>,
): OverrideWidens | undefined => {
  const widened = [
    ...POLICY_OPERATIONS.filter((operation) => {
      const override = policy.overrides[operation];
      return override !== undefined && !isNarrowerOrEqual(override, PRESET_DECISIONS[preset][operation]);
    }),
    ...charmOperations
      .filter((operation) => {
        const override = policy.charms?.overrides?.[operation.id];
        return override !== undefined && !isNarrowerOrEqual(override, operation.presets[preset]);
      })
      .map((operation) => operation.id),
  ];
  return widened.length === 0
    ? undefined
    : new OverrideWidens({
        preset,
        operations: widened,
        message: `An override can only narrow the ${preset} preset; ${widened.join(", ")} would allow more`,
      });
};

/** An override for a Charm operation no Charm the hub holds declares, which is never stored (ADR 031). */
const checkDeclared = (
  overrides: CharmOverrides,
  charmOperations: ReadonlyArray<CharmOperation>,
): UndeclaredOperation | undefined => {
  const undeclared = Object.keys(overrides).filter((id) => !charmOperations.some((operation) => operation.id === id));
  return undeclared.length === 0
    ? undefined
    : new UndeclaredOperation({
        operations: undeclared,
        message: `No Charm on this hub declares ${undeclared.join(", ")}`,
      });
};

/** A Charm granted to the hob that the hub does not hold, which is never stored (ADR 031). */
const checkHeld = (
  granted: ReadonlyArray<CharmId>,
  charms: ReadonlyArray<CharmDeclaration>,
): UnknownCharm | undefined => {
  const unknown = granted.filter((id) => !charms.some((charm) => charm.id === id));
  return unknown.length === 0
    ? undefined
    : new UnknownCharm({ charms: unknown, message: `This hub holds no Charm called ${unknown.join(", ")}` });
};

/**
 * The answers a change gives checked, when it gives any: a Charm the hub does not hold is refused
 * first, then a Charm override no Charm declares, then any override that widens its preset.
 */
const checkAnswers = (
  payload: UpdateHobPermissionsPayload,
  preset: SafetyPreset,
  policy: HobPolicy,
  charms: ReadonlyArray<CharmDeclaration>,
): UnknownCharm | UndeclaredOperation | OverrideWidens | undefined => {
  const granted = payload.charms?.granted;
  if (granted !== undefined) {
    const unknown = checkHeld(granted, charms);
    if (unknown !== undefined) return unknown;
  }
  const charmOverrides = payload.charms?.overrides;
  if (payload.overrides === undefined && charmOverrides === undefined) return undefined;
  const charmOperations = declaredOperations(charms);
  return (
    (charmOverrides && checkDeclared(charmOverrides, charmOperations)) ??
    checkOverrides(preset, policy, charmOperations)
  );
};

/**
 * The Charms a change grants the hob: the set it gives, or the hob's own with the GitHub Charm added
 * or taken away when it asks as clients did before ADR 031, or the hob's own unchanged. Left
 * unchanged, a hob that never chose its Charms keeps holding those every hob starts with.
 */
const changedCharms = (before: HobPolicy, change: UpdateHobPermissionsPayload): ReadonlyArray<CharmId> | undefined => {
  if (change.charms?.granted !== undefined) return [...new Set(change.charms.granted)];
  if (change.githubCharm === undefined) return before.charms?.granted;
  const others = heldCharms(before).filter((id) => id !== "github");
  return change.githubCharm ? [...others, "github"] : others;
};

/**
 * The Charm overrides a change leaves: the ones it gives, or the hob's own, with the Summoning
 * Charm's defaults written under the ones it gives when it grants that Charm or turns "Can manage
 * itself" on (ADR 034).
 */
const changedOverrides = (before: HobPolicy, change: UpdateHobPermissionsPayload, granted: ReadonlyArray<CharmId>) => {
  const given = change.charms?.overrides;
  const kept = given ?? before.charms?.overrides ?? {};
  const heldBefore = holdsCharm(before, SUMMONING_CHARM_ID);
  const granting = !heldBefore && granted.includes(SUMMONING_CHARM_ID);
  const scope = change.charms?.summoning ?? summoningScopeOf(before);
  const selfTurnedOn = scope.self && !(heldBefore && summoningScopeOf(before).self);
  if (!granted.includes(SUMMONING_CHARM_ID)) return kept;
  return { ...kept, ...summoningDefaultsFor({ granting, selfTurnedOn }), ...given };
};

/** What a change leaves the hob of the Charms, each part left out when it has none. */
const changedHobCharms = (before: HobPolicy, change: UpdateHobPermissionsPayload): HobCharms => {
  const granted = changedCharms(before, change);
  const charmOverrides = changedOverrides(before, change, granted ?? heldCharms(before));
  const summoning = change.charms?.summoning ?? before.charms?.summoning;
  const withheld = change.charms?.withheld ?? before.charms?.withheld ?? [];
  return {
    ...(granted === undefined ? {} : { granted }),
    ...(Object.keys(charmOverrides).length === 0 ? {} : { overrides: charmOverrides }),
    ...(summoning === undefined ? {} : { summoning }),
    ...(withheld.length === 0 ? {} : { withheld: [...new Set(withheld)] }),
  };
};

/** `before` with each field the change gives replaced; Charm overrides are left out when there are none. */
export const changedPolicy = (before: HobPolicy, change: UpdateHobPermissionsPayload): HobPolicy => {
  const charms = changedHobCharms(before, change);
  return {
    ownFolders: change.ownFolders ?? before.ownFolders,
    hiddenSharedFolders: change.hiddenSharedFolders ?? before.hiddenSharedFolders,
    overrides: change.overrides ?? before.overrides,
    ...(Object.keys(charms).length === 0 ? {} : { charms }),
    ...((change.signCommits ?? before.signCommits) === true ? { signCommits: true } : {}),
  };
};

/** Two sets of Charm ids hold the same Charms. */
const sameCharms = (a: ReadonlyArray<CharmId>, b: ReadonlyArray<CharmId>) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** Two answer records give the same answer for every operation either names. */
const sameAnswers = (a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((operation) => a[operation] === b[operation]);

/** Two policies hold the same folders, in the same order, the same overrides, signing and Charms. */
const samePolicy = (a: HobPolicy, b: HobPolicy) =>
  (a.signCommits === true) === (b.signCommits === true) &&
  sameCharms(heldCharms(a), heldCharms(b)) &&
  sameCharms(a.charms?.withheld ?? [], b.charms?.withheld ?? []) &&
  JSON.stringify(a.charms?.summoning ?? null) === JSON.stringify(b.charms?.summoning ?? null) &&
  a.ownFolders.join("\0") === b.ownFolders.join("\0") &&
  a.hiddenSharedFolders.join("\0") === b.hiddenSharedFolders.join("\0") &&
  sameAnswers(hobAnswers(a), hobAnswers(b));

const roleFields = ["role", "roleTitle", "sigil", "hat", "tool"] as const;
const toneFields = ["voice", "length"] as const;

const createdFields = [
  "name",
  ...roleFields,
  "goodAt",
  ...toneFields,
  "lookSeed",
  "lookColor",
  "runtime",
  "model",
  "effort",
  "instructions",
  "visibleToHobs",
] as const satisfies ReadonlyArray<keyof CreateAgentPayload & keyof Agent>;

/**
 * A new hob's request with what it leaves out filled in, so a retry that leaves it out matches: the
 * default tone, visible to other hobs, and good at stored as one line, or the prefill of its chores
 * and role when it gives none.
 */
const withDefaults = (payload: CreateAgentPayload) => ({
  voice: DEFAULT_VOICE,
  length: DEFAULT_LENGTH,
  visibleToHobs: true,
  ...payload,
  goodAt: payload.goodAt === undefined ? goodAtFromInstructions(payload) : normalizeGoodAt(payload.goodAt),
});

const editableFields = [
  "name",
  ...roleFields,
  "goodAt",
  ...toneFields,
  "lookSeed",
  "lookColor",
  "runtime",
  "model",
  "effort",
  "instructions",
  "visibleToHobs",
] as const satisfies ReadonlyArray<keyof UpdateAgentPayload & keyof Agent>;

/**
 * Who summons a new hob and for what (ADR 034). The hob behind the actor, the one that summons it or
 * proposes it, is recorded as the hob that summoned it; you summon it when the actor is you.
 */
export interface Summoning {
  readonly actor: ChangeActor;
  /** The Task it is summoned for; none when left out. */
  readonly taskId?: TaskId | null;
  /** Whether a hob summons it without a card for you; not when left out. */
  readonly unattended?: boolean;
  /**
   * The policy it is created with, for a hob a hob summons (ADR 034), already checked against its
   * manager's, its folders canonical. A hob you summon starts with the empty policy.
   */
  readonly policy?: HobPolicy;
}

const BY_YOU: Summoning = { actor: YOU };

/** A change to a hob's profile and permissions together, each left out when it changes none. */
export interface HobChange {
  readonly profile?: UpdateAgentPayload;
  readonly permissions?: UpdateHobPermissionsPayload;
}

export class HobService extends Context.Service<
  HobService,
  {
    /** Creates the hob as summoned by `summoning`, by you when left out. */
    readonly create: (payload: CreateAgentPayload, summoning?: Summoning) => Effect.Effect<Agent, InvalidHob>;
    /**
     * Applies an edit as the hob's next configuration version, made by `actor` (you when left out);
     * an edit that changes nothing adds none.
     */
    readonly update: (
      id: AgentId,
      payload: UpdateAgentPayload,
      actor?: ChangeActor,
    ) => Effect.Effect<Agent, InvalidHob | AgentNotFound>;
    /**
     * `update` with `check` run first and `then` after it, all under the hob's lock, so nothing else
     * that takes the lock (a thread archived, a turn started) lands between them. A failed check
     * stores nothing. Neither step may take the hob's lock itself.
     */
    readonly updateThen: <A, E>(
      id: AgentId,
      payload: UpdateAgentPayload,
      check: Effect.Effect<void, E>,
      then: (agent: Agent) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | InvalidHob | AgentNotFound>;
    /**
     * Changes the hob's own folders, hidden shared folders or overrides as its next configuration
     * version, checked against the installation's current preset and shared folders (ADR 014).
     * A change that changes nothing adds no version. Made by `actor`, you when left out.
     */
    readonly updatePolicy: (
      id: AgentId,
      payload: UpdateHobPermissionsPayload,
      actor?: ChangeActor,
    ) => Effect.Effect<Agent, AgentNotFound | InvalidFolder | OverrideWidens | UndeclaredOperation | UnknownCharm>;
    /**
     * `update` and `updatePolicy` as one configuration version, made by `actor`: both are checked
     * before either is stored, so a change one of them refuses stores nothing (ADR 034).
     */
    readonly change: (
      id: AgentId,
      change: HobChange,
      actor: ChangeActor,
    ) => Effect.Effect<
      Agent,
      InvalidHob | AgentNotFound | InvalidFolder | OverrideWidens | UndeclaredOperation | UnknownCharm
    >;
  }
>()("@hobbots/agents/HobService") {
  static readonly layer = Layer.effect(
    HobService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventPublisher;
      // Read once: the Charms a hub holds are fixed when it starts (ADR 031).
      const charms = yield* CharmDeclarations;
      const adapters = yield* runtimeAdapters;
      const admission = yield* HobAdmission;
      const setup = yield* InstallationSettings;
      const folders = yield* FolderChecks;

      // Under the hob's lock, so the event carries the status the hob has when the change is stored:
      // a retirement publishes after it and a stale change cannot re-list a retired hob. Another
      // change may land between reading the hob and storing the next version; then `change` applies
      // again on top of that one, so both survive. `change` returns the hob unchanged for a no-op.
      // Runs under the hob's lock.
      const storeVersion = <E>(id: AgentId, change: (agent: Agent) => Effect.Effect<Agent, E>, actor: ChangeActor) =>
        Effect.gen(function* () {
          while (true) {
            const current = yield* repo.findAgent(id);
            if (Option.isNone(current)) return yield* new AgentNotFound({ agentId: id });
            const next = yield* change(current.value);
            if (next === current.value) return next;
            const updated = yield* repo.updateAgentConfig(
              new Agent({ ...next, configVersion: current.value.configVersion + 1 }),
              actor,
            );
            if (Option.isSome(updated)) {
              yield* bus.publish(updated.value.entries);
              return updated.value.value;
            }
          }
        });
      const nextVersion = <E>(id: AgentId, change: (agent: Agent) => Effect.Effect<Agent, E>, actor: ChangeActor) =>
        admission.withHob(id, storeVersion(id, change, actor));

      // A retry carries the same id and fields; the same id with other fields is another hob.
      const retried = (existing: Agent, payload: CreateAgentPayload) =>
        createdFields.every((field) => existing[field] === withDefaults(payload)[field])
          ? Effect.succeed(existing)
          : Effect.fail(new InvalidHob({ field: "id", message: "Another hob already has this id" }));

      const create = Effect.fn("HobService.create")(function* (
        payload: CreateAgentPayload,
        summoning: Summoning = BY_YOU,
      ) {
        const { id = AgentId.make(crypto.randomUUID()), ...fields } = withDefaults(payload);
        // Reconcile first, so a retry succeeds even if the runtime's model list changed since.
        const earlier = Option.getOrUndefined(yield* repo.findAgent(id));
        if (earlier !== undefined) return yield* retried(earlier, payload);
        const invalid =
          checkRole(payload) ?? checkGoodAt(fields.goodAt) ?? (yield* checkRuntimeBrain(adapters, payload));
        if (invalid !== undefined) return yield* invalid;
        const agent = new Agent({
          ...fields,
          id,
          configVersion: 1,
          summonedBy: hobBehind(summoning.actor),
          summonedFor: summoning.taskId ?? null,
          summonedUnattended: summoning.unattended ?? false,
          ...(summoning.policy === undefined ? {} : { policy: summoning.policy }),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        const inserted = yield* repo.insertAgent(agent, summoning.actor);
        if (Option.isNone(inserted)) {
          // A concurrent request with the same id inserted first.
          const raced = yield* repo.findAgent(id).pipe(Effect.map(Option.getOrThrow));
          return yield* retried(raced, payload);
        }
        yield* bus.publish(inserted.value.entries);
        return inserted.value.value;
      });

      // The edit applied to the hob as it is stored now; the hob itself when it changes nothing.
      const applyEdit = (edit: UpdateAgentPayload) => {
        // Taking a starter role brings its title; good at is stored as one line.
        const payload = {
          ...edit,
          ...(edit.role != null && edit.roleTitle === undefined && { roleTitle: starterRole(edit.role).title }),
          ...(edit.goodAt !== undefined && { goodAt: normalizeGoodAt(edit.goodAt) }),
        };
        return (agent: Agent) =>
          Effect.gen(function* () {
            if (editableFields.every((field) => payload[field] === undefined || payload[field] === agent[field])) {
              return agent;
            }
            // A brain left as it was stays valid even if the runtime stopped offering it.
            if (payload.runtime !== undefined || payload.model !== undefined || payload.effort !== undefined) {
              const invalid = yield* checkRuntimeBrain(adapters, {
                runtime: payload.runtime ?? agent.runtime,
                model: payload.model === undefined ? agent.model : payload.model,
                effort: payload.effort === undefined ? agent.effort : payload.effort,
              });
              if (invalid !== undefined) return yield* invalid;
            }
            const next = new Agent({ ...agent, ...payload });
            const invalidRole = checkRole(next) ?? checkGoodAt(payload.goodAt);
            if (invalidRole !== undefined) return yield* invalidRole;
            return next;
          });
      };

      const update = Effect.fn("HobService.update")(function* (
        id: AgentId,
        edit: UpdateAgentPayload,
        actor: ChangeActor = YOU,
      ) {
        return yield* nextVersion(id, applyEdit(edit), actor);
      });

      const updateThen = <A, E>(
        id: AgentId,
        edit: UpdateAgentPayload,
        check: Effect.Effect<void, E>,
        then: (agent: Agent) => Effect.Effect<A, E>,
      ) =>
        admission
          .withHob(id, check.pipe(Effect.andThen(storeVersion(id, applyEdit(edit), YOU)), Effect.flatMap(then)))
          .pipe(Effect.withSpan("HobService.updateThen"));

      /** A permissions change's folders, canonical, as it is stored. */
      const canonicalPolicy = (payload: UpdateHobPermissionsPayload) =>
        Effect.gen(function* () {
          // Own folders are checked on the hub and stored canonical, once each, where first added.
          const ownFolders = payload.ownFolders && [
            ...new Set(yield* Effect.forEach(payload.ownFolders, (folder) => folders.check(folder))),
          ];
          // A hidden folder is stored canonical too, so any spelling of a shared folder hides it. One
          // missing from the hub keeps its spelling; it is compared by identity whenever it is read.
          const hiddenSharedFolders = payload.hiddenSharedFolders && [
            ...new Set(yield* Effect.forEach(payload.hiddenSharedFolders, folders.identity)),
          ];
          return { ownFolders, hiddenSharedFolders };
        });

      /** The hob with a permissions change applied, checked against the setup as it is now. */
      const applyPolicy =
        (payload: UpdateHobPermissionsPayload, canonical: Effect.Success<ReturnType<typeof canonicalPolicy>>) =>
        (agent: Agent) =>
          Effect.gen(function* () {
            const { ownFolders, hiddenSharedFolders } = canonical;
            // Read inside the retry, so each attempt checks against the setup as it is then.
            const { safetyPreset, approvedFolders } = yield* setup.get;
            const policy = changedPolicy(agent.policy, {
              ...payload,
              ...(ownFolders && { ownFolders }),
              ...(hiddenSharedFolders && { hiddenSharedFolders }),
            });
            if (samePolicy(policy, agent.policy)) return agent;
            // Only what changes is checked, so a shared folder removed in setup since does not block
            // an unrelated change, and a stricter preset does not reject an override kept as it was.
            if (ownFolders !== undefined) {
              const shared = ownFolders.find((folder) => approvedFolders.includes(folder));
              if (shared !== undefined) {
                return yield* new InvalidFolder({
                  folder: shared,
                  message: `${shared} is already shared with every hob`,
                });
              }
            }
            if (hiddenSharedFolders !== undefined) {
              const isShared = yield* sameFolderIn(folders, approvedFolders);
              const unknown = yield* Effect.findFirst(policy.hiddenSharedFolders, (folder) =>
                Effect.map(isShared(folder), (shared) => !shared),
              ).pipe(Effect.map(Option.getOrUndefined));
              if (unknown !== undefined) {
                return yield* new InvalidFolder({ folder: unknown, message: `${unknown} is not a shared folder` });
              }
            }
            const refused = checkAnswers(payload, safetyPreset, policy, charms);
            if (refused !== undefined) return yield* refused;
            return new Agent({ ...agent, policy });
          });

      const updatePolicy = Effect.fn("HobService.updatePolicy")(function* (
        id: AgentId,
        payload: UpdateHobPermissionsPayload,
        actor: ChangeActor = YOU,
      ) {
        const canonical = yield* canonicalPolicy(payload);
        return yield* nextVersion(id, applyPolicy(payload, canonical), actor);
      });

      const change = Effect.fn("HobService.change")(function* (id: AgentId, change: HobChange, actor: ChangeActor) {
        const canonical = change.permissions && (yield* canonicalPolicy(change.permissions));
        const permissions = change.permissions;
        return yield* nextVersion(
          id,
          (agent) =>
            applyEdit(change.profile ?? {})(agent).pipe(
              Effect.flatMap((edited) =>
                permissions === undefined || canonical === undefined
                  ? Effect.succeed(edited)
                  : applyPolicy(permissions, canonical)(edited),
              ),
            ),
          actor,
        );
      });

      return HobService.of({ create, update, updateThen, updatePolicy, change });
    }),
  );
}
