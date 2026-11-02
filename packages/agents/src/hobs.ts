import {
  AgentNotFound,
  type CreateAgentPayload,
  InvalidFolder,
  InvalidHob,
  OverrideWidens,
  type UpdateAgentPayload,
  type UpdateHobPermissionsPayload,
} from "@hobbots/api";
import {
  Agent,
  AgentId,
  DEFAULT_LENGTH,
  DEFAULT_VOICE,
  type Effort,
  type HobPolicy,
  isNarrowerOrEqual,
  POLICY_OPERATIONS,
  PRESET_DECISIONS,
  type RoleId,
  RUNTIME_NAMES,
  type RuntimeKind,
  type RuntimeModels,
  type SafetyPreset,
  starterRole,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission } from "./admission.ts";
import { sameFolderIn } from "./folders.ts";
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
 * runtime with no adapter, or a model or effort it does not offer, is refused.
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
  return Effect.map(adapter.models, (offered) => checkBrain(offered, brain));
};

/** The hob a lookup found, or `AgentNotFound` when there is none with this ID. */
export const foundAgent =
  (agentId: AgentId) =>
  (agent: Option.Option<Agent>): Effect.Effect<Agent, AgentNotFound> =>
    Option.match(agent, { onNone: () => Effect.fail(new AgentNotFound({ agentId })), onSome: Effect.succeed });

/** A starter role keeps its own title; a title in the user's own words goes with no role. */
const checkRole = (role: { readonly role: RoleId | null; readonly roleTitle: string }): InvalidHob | undefined => {
  if (role.role === null) return undefined;
  const title = starterRole(role.role).title;
  return role.roleTitle === title
    ? undefined
    : new InvalidHob({ field: "roleTitle", message: `The ${title} role is titled "${title}"` });
};

/** An override that would allow more than the preset, naming each operation it widens. */
const checkOverrides = (preset: SafetyPreset, overrides: HobPolicy["overrides"]): OverrideWidens | undefined => {
  const widened = POLICY_OPERATIONS.filter((operation) => {
    const override = overrides[operation];
    return override !== undefined && !isNarrowerOrEqual(override, PRESET_DECISIONS[preset][operation]);
  });
  return widened.length === 0
    ? undefined
    : new OverrideWidens({
        preset,
        operations: widened,
        message: `An override can only narrow the ${preset} preset; ${widened.join(", ")} would allow more`,
      });
};

/** Two policies hold the same folders, in the same order, the same overrides, signing and Charms. */
const samePolicy = (a: HobPolicy, b: HobPolicy) =>
  (a.signCommits === true) === (b.signCommits === true) &&
  (a.githubCharm !== false) === (b.githubCharm !== false) &&
  a.ownFolders.join("\0") === b.ownFolders.join("\0") &&
  a.hiddenSharedFolders.join("\0") === b.hiddenSharedFolders.join("\0") &&
  POLICY_OPERATIONS.every((operation) => a.overrides[operation] === b.overrides[operation]);

const roleFields = ["role", "roleTitle", "sigil", "hat", "tool"] as const;
const toneFields = ["voice", "length"] as const;

const createdFields = [
  "name",
  ...roleFields,
  ...toneFields,
  "lookSeed",
  "lookColor",
  "runtime",
  "model",
  "effort",
  "instructions",
] as const satisfies ReadonlyArray<keyof CreateAgentPayload & keyof Agent>;

/** A new hob's request with its tone filled in, so a retry that leaves the tone out matches. */
const withTone = (payload: CreateAgentPayload) => ({
  voice: DEFAULT_VOICE,
  length: DEFAULT_LENGTH,
  ...payload,
});

const editableFields = [
  ...roleFields,
  ...toneFields,
  "lookSeed",
  "lookColor",
  "runtime",
  "model",
  "effort",
  "instructions",
] as const satisfies ReadonlyArray<keyof UpdateAgentPayload & keyof Agent>;

export class HobService extends Context.Service<
  HobService,
  {
    readonly create: (payload: CreateAgentPayload) => Effect.Effect<Agent, InvalidHob>;
    /** Applies an edit as the hob's next configuration version; an edit that changes nothing adds none. */
    readonly update: (id: AgentId, payload: UpdateAgentPayload) => Effect.Effect<Agent, InvalidHob | AgentNotFound>;
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
     * A change that changes nothing adds no version.
     */
    readonly updatePolicy: (
      id: AgentId,
      payload: UpdateHobPermissionsPayload,
    ) => Effect.Effect<Agent, AgentNotFound | InvalidFolder | OverrideWidens>;
  }
>()("@hobbots/agents/HobService") {
  static readonly layer = Layer.effect(
    HobService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventPublisher;
      const adapters = yield* runtimeAdapters;
      const admission = yield* HobAdmission;
      const setup = yield* InstallationSettings;
      const folders = yield* FolderChecks;

      // Under the hob's lock, so the event carries the status the hob has when the change is stored:
      // a retirement publishes after it and a stale change cannot re-list a retired hob. Another
      // change may land between reading the hob and storing the next version; then `change` applies
      // again on top of that one, so both survive. `change` returns the hob unchanged for a no-op.
      // Runs under the hob's lock.
      const storeVersion = <E>(id: AgentId, change: (agent: Agent) => Effect.Effect<Agent, E>) =>
        Effect.gen(function* () {
          while (true) {
            const current = yield* repo.findAgent(id);
            if (Option.isNone(current)) return yield* new AgentNotFound({ agentId: id });
            const next = yield* change(current.value);
            if (next === current.value) return next;
            const updated = yield* repo.updateAgentConfig(
              new Agent({ ...next, configVersion: current.value.configVersion + 1 }),
            );
            if (Option.isSome(updated)) {
              yield* bus.publish(updated.value.entries);
              return updated.value.value;
            }
          }
        });
      const nextVersion = <E>(id: AgentId, change: (agent: Agent) => Effect.Effect<Agent, E>) =>
        admission.withHob(id, storeVersion(id, change));

      // A retry carries the same id and fields; the same id with other fields is another hob.
      const retried = (existing: Agent, payload: CreateAgentPayload) =>
        createdFields.every((field) => existing[field] === withTone(payload)[field])
          ? Effect.succeed(existing)
          : Effect.fail(new InvalidHob({ field: "id", message: "Another hob already has this id" }));

      const create = Effect.fn("HobService.create")(function* (payload: CreateAgentPayload) {
        const { id = AgentId.make(crypto.randomUUID()), ...fields } = payload;
        // Reconcile first, so a retry succeeds even if the runtime's model list changed since.
        const earlier = Option.getOrUndefined(yield* repo.findAgent(id));
        if (earlier !== undefined) return yield* retried(earlier, payload);
        const invalid = checkRole(payload) ?? (yield* checkRuntimeBrain(adapters, payload));
        if (invalid !== undefined) return yield* invalid;
        const agent = new Agent({
          ...fields,
          id,
          configVersion: 1,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        const inserted = yield* repo.insertAgent(agent);
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
        // Taking a starter role brings its title.
        const payload =
          edit.role != null && edit.roleTitle === undefined
            ? { ...edit, roleTitle: starterRole(edit.role).title }
            : edit;
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
            const invalidRole = checkRole(next);
            if (invalidRole !== undefined) return yield* invalidRole;
            return next;
          });
      };

      const update = Effect.fn("HobService.update")(function* (id: AgentId, edit: UpdateAgentPayload) {
        return yield* nextVersion(id, applyEdit(edit));
      });

      const updateThen = <A, E>(
        id: AgentId,
        edit: UpdateAgentPayload,
        check: Effect.Effect<void, E>,
        then: (agent: Agent) => Effect.Effect<A, E>,
      ) =>
        admission
          .withHob(id, check.pipe(Effect.andThen(storeVersion(id, applyEdit(edit))), Effect.flatMap(then)))
          .pipe(Effect.withSpan("HobService.updateThen"));

      const updatePolicy = Effect.fn("HobService.updatePolicy")(function* (
        id: AgentId,
        payload: UpdateHobPermissionsPayload,
      ) {
        // Own folders are checked on the hub and stored canonical, once each, where first added.
        const ownFolders = payload.ownFolders && [
          ...new Set(yield* Effect.forEach(payload.ownFolders, (folder) => folders.check(folder))),
        ];
        // A hidden folder is stored canonical too, so any spelling of a shared folder hides it. One
        // missing from the hub keeps its spelling; it is compared by identity whenever it is read.
        const hiddenSharedFolders = payload.hiddenSharedFolders && [
          ...new Set(yield* Effect.forEach(payload.hiddenSharedFolders, folders.identity)),
        ];
        return yield* nextVersion(id, (agent) =>
          Effect.gen(function* () {
            // Read inside the retry, so each attempt checks against the setup as it is then.
            const { safetyPreset, approvedFolders } = yield* setup.get;
            const policy: HobPolicy = {
              ownFolders: ownFolders ?? agent.policy.ownFolders,
              hiddenSharedFolders: hiddenSharedFolders ?? agent.policy.hiddenSharedFolders,
              overrides: payload.overrides ?? agent.policy.overrides,
              ...((payload.signCommits ?? agent.policy.signCommits) === true ? { signCommits: true } : {}),
              ...((payload.githubCharm ?? agent.policy.githubCharm) === false ? { githubCharm: false } : {}),
            };
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
            if (payload.overrides !== undefined) {
              const widens = checkOverrides(safetyPreset, policy.overrides);
              if (widens !== undefined) return yield* widens;
            }
            return new Agent({ ...agent, policy });
          }),
        );
      });

      return HobService.of({ create, update, updateThen, updatePolicy });
    }),
  );
}
