import {
  type CreateAgentPayload,
  HobProposalRefused,
  type UpdateAgentPayload,
  type UpdateHobPermissionsPayload,
} from "@hobbots/api";
import {
  Agent,
  AgentId,
  type AnyOperation,
  type ChangeActor,
  type CharmCall,
  type CharmId,
  type CharmOperation,
  type CharmOperationId,
  type CharmOverrides,
  DEFAULT_SIGIL,
  DEFAULT_SUMMON_LIMITS,
  DRAFT_FIELDS,
  fieldsSet,
  HOB_LABEL_MAX,
  HobColor,
  type HobPolicy,
  type HobProposal,
  type HobProposalKind,
  type HobProposalRow,
  heldCharms,
  hobProfilePath,
  hobProposalOutcomeText,
  holdsCharm,
  isCharmOperation,
  isNarrowerOrEqual,
  narrowest,
  PAUSE_OPERATION,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type PolicyLayer,
  type PolicyOverrides,
  RETIRE_OPERATION,
  SELF_FIELD_OF,
  SUMMON_OPERATION,
  SUMMONING_CHANGE_TOOL,
  SUMMONING_CHARM,
  SUMMONING_CHARM_ID,
  SUMMONING_CHARM_NAME,
  SUMMONING_CHECK_TOOL,
  SUMMONING_FIELD_WORDS,
  SUMMONING_SUMMON_TOOL,
  SUMMONING_TOOLS,
  type SummonCaps,
  type SummoningChange,
  type SummoningDraft,
  type SummoningField,
  SummoningInputs,
  type SummoningToolName,
  type SummonLimits,
  selfFieldOperation,
  starterRole,
  summoningFieldOperation,
  summoningScopeOf,
  summoningToolJsonSchema,
  type TaskId,
  unattendedSummonsBy,
  unattendedSummonsIn,
  withSummoningForEveryHob,
  YOU,
} from "@hobbots/domain";
import { Context, Deferred, Effect, Layer, Option, Semaphore } from "effect";
import type { AskableVerdict } from "./asking.ts";
import { type Charm, defineCharm } from "./charms.ts";
import { ChatService } from "./chat.ts";
import { sameFolderIn } from "./folders.ts";
import { CharmDeclarations, GrantService } from "./grants.ts";
import { HobChanges } from "./hob-changes.ts";
import { type HobProposalApplier, HobProposals, pendingRow } from "./hob-proposals.ts";
import { changedPolicy, checkGoodAt, checkRole, checkRuntimeBrain, HobService } from "./hobs.ts";
import { type HubAction, type HubPlanContext, HubRefusal, hubAction } from "./hub-actions.ts";
import { HobLifecycle } from "./lifecycle.ts";
import { changePermissions } from "./permissions.ts";
import { FolderChecks, HobGitHubApps, InstallationSettings } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import {
  type RuntimeAdapters,
  runtimeAdapters,
  type ToolAccess,
  type ToolPolicy,
  type TurnApprovals,
} from "./runtime.ts";
import { TaskRepository } from "./tasks.ts";
import { accessNow, HobTools, operationDecision } from "./tools.ts";

/**
 * The Summoning Charm's actions (ADR 034): a hob summons, changes, pauses, wakes and retires hobs
 * within the scope and field answers you set, through the same use cases as Summon and the profile,
 * and never wider than itself. Every call runs on the hub action pipeline (ADR 031), so it is
 * decided, asked about, recorded and keyed like any Charm call, on every runtime alike.
 */

/** What the Charm's calls reach on the hub: the hob use cases and what they read. */
export interface SummoningServices {
  readonly hobs: HobService["Service"];
  readonly lifecycle: HobLifecycle["Service"];
  readonly repo: HobbotsRepository["Service"];
  readonly adapters: RuntimeAdapters;
  readonly folders: FolderChecks["Service"];
  readonly setup: InstallationSettings["Service"];
  readonly apps: Option.Option<HobGitHubApps["Service"]>;
  /** Writes a permissions change and takes back from the hob's grants and turns what it took away. */
  readonly changePermissions: ReturnType<typeof changePermissions>;
  /** The Task trees a summon's tree cap counts in. */
  readonly tasks: TaskRepository["Service"];
  readonly limits: SummonLimits;
  /** Where a call that asks records its proposal and waits for you (ADR 034). */
  readonly proposals: HobProposals["Service"];
  /** Each hob's versions and status changes with who made them, for settling a row a stopped hub left. */
  readonly changes: HobChanges["Service"];
  /** A hob's tool access as its next turn would read it, for applying a proposal outside any turn. */
  readonly access: (agentId: AgentId) => Effect.Effect<ToolAccess | null>;
}

/**
 * The caps on summons that run without asking you (ADR 034), 4 per manager and 3 per Task tree
 * unless the hub's composition sets others.
 */
export const UnattendedSummonLimits = Context.Reference<SummonLimits>("@hobbots/agents/UnattendedSummonLimits", {
  defaultValue: () => DEFAULT_SUMMON_LIMITS,
});

/** A hob's unattended summons against the caps, as the Charms tab shows them (ADR 034). */
export const summonCapsOf = (agents: ReadonlyArray<Agent>, agentId: AgentId, limits: SummonLimits): SummonCaps => ({
  live: unattendedSummonsBy(agents, agentId),
  perHob: limits.maxUnattendedPerHob,
  perTree: limits.maxUnattendedPerTree,
});

/**
 * The hob use cases the Summoning Charm calls, bound once the hub has built them. The Charm is
 * registered before them, since they read what the Charms declare, so its calls wait for the binding,
 * which the hub makes before it serves any turn.
 */
export class SummoningHub extends Context.Service<
  SummoningHub,
  {
    readonly services: Effect.Effect<SummoningServices>;
    readonly bind: (services: SummoningServices) => Effect.Effect<void>;
    /** How a proposal's rows are made, which the Charm binds once it is built. */
    readonly applier: Effect.Effect<HobProposalApplier>;
    readonly bindApplier: (applier: HobProposalApplier) => Effect.Effect<void>;
  }
>()("@hobbots/agents/SummoningHub") {
  static readonly layer = Layer.effect(
    SummoningHub,
    Effect.gen(function* () {
      const bound = yield* Deferred.make<SummoningServices>();
      const applier = yield* Deferred.make<HobProposalApplier>();
      return SummoningHub.of({
        services: Deferred.await(bound),
        bind: (services) => Deferred.succeed(bound, services).pipe(Effect.asVoid),
        applier: Deferred.await(applier),
        bindApplier: (made) => Deferred.succeed(applier, made).pipe(Effect.asVoid),
      });
    }),
  );

  /** Binds the hub's hob use cases to the Charm, where they are built. */
  static readonly bound = Layer.effectDiscard(
    Effect.gen(function* () {
      const hub = yield* SummoningHub;
      const proposals = yield* HobProposals;
      const repo = yield* HobbotsRepository;
      const hobTools = yield* HobTools;
      // The proposals reach the Charm's way of making a row once the Charm is built.
      yield* proposals.bindApplier({
        apply: (proposal, row, edited) => Effect.flatMap(hub.applier, (made) => made.apply(proposal, row, edited)),
        changedSince: (row) => Effect.flatMap(hub.applier, (made) => made.changedSince(row)),
        alwaysAllow: (proposal, operations) =>
          Effect.flatMap(hub.applier, (made) => made.alwaysAllow(proposal, operations)),
        reconcile: (proposal, row) => Effect.flatMap(hub.applier, (made) => made.reconcile(proposal, row)),
      });
      yield* hub.bind({
        hobs: yield* HobService,
        lifecycle: yield* HobLifecycle,
        repo: yield* HobbotsRepository,
        adapters: yield* runtimeAdapters,
        folders: yield* FolderChecks,
        setup: yield* InstallationSettings,
        apps: yield* Effect.serviceOption(HobGitHubApps),
        changePermissions: changePermissions({
          repo: yield* HobbotsRepository,
          grants: yield* GrantService,
          chat: yield* ChatService,
          charms: yield* CharmDeclarations,
        }),
        tasks: yield* TaskRepository,
        limits: yield* UnattendedSummonLimits,
        proposals,
        changes: yield* HobChanges,
        access: (agentId) => accessNow(repo, hobTools, agentId),
      });
    }),
  );
}

/** A Charm request on one of the Summoning Charm's operations, as the policy engine decides it. */
export interface SummoningPolicyRequest {
  readonly _tag: "Charm";
  readonly charm: CharmId;
  readonly operation: CharmOperationId;
  readonly site: Readonly<Record<string, string>>;
  readonly targets: ReadonlyArray<string>;
}

/**
 * A Summoning call's request (ADR 034): every operation it is decided on, per target hob and field,
 * and the reason every one of them asks whatever its answer, for a target wider than the manager.
 */
interface SummoningRequest {
  readonly _tag: "Charm";
  readonly charm: CharmId;
  readonly operation: CharmOperationId;
  readonly parts: ReadonlyArray<SummoningPolicyRequest>;
  readonly safety: string | null;
}

/** Decides one Charm request with the hob's live grants, as `decideHubCall` does. */
export type DecideSummoning = (
  approvals: TurnApprovals | null,
  base: ToolAccess,
  request: SummoningPolicyRequest,
) => (fresh: ToolAccess | null) => Effect.Effect<AskableVerdict>;

/** The narrower of two verdicts on one call; two asks ask once, once only when either is. */
const narrowerVerdict = (first: AskableVerdict, second: AskableVerdict): AskableVerdict => {
  if (first.decision === "ask" && second.decision === "ask") {
    return { ...first, onceOnly: first.onceOnly || second.onceOnly, grantable: false, rules: [] };
  }
  return narrowest(first.decision, second.decision) === first.decision ? first : second;
};

/**
 * A verdict that asks for a safety reason (ADR 034): an Allow becomes an Ask, once only, that no
 * grant answers; a Never stays Never.
 */
const safetyAsk = (verdict: AskableVerdict, reason: string): AskableVerdict =>
  verdict.decision === "deny"
    ? verdict
    : {
        ...verdict,
        decision: "ask",
        reason: { ...verdict.reason, message: reason },
        onceOnly: true,
        grantable: false,
        rules: [],
        grantIds: [],
      };

/** Refuses with a reason code first, as ADR 034 names them, then the words. */
const refused = (code: string, message: string) => new HubRefusal({ message: `Refused (${code}): ${message}` });

/** Whether `folder` is `path` or holds it, both canonical, on a hub whose paths divide at `separator`. */
const holdsPath = (folder: string, path: string, separator: string) =>
  path === folder || path.startsWith(folder.endsWith(separator) ? folder : `${folder}${separator}`);

/** What a hob may do, as the no-escalation rule compares two hobs (ADR 034). */
interface Authority {
  readonly ownFolders: ReadonlyArray<string>;
  /** The shared folders it does not hide. */
  readonly shared: ReadonlyArray<string>;
  readonly charms: ReadonlyArray<CharmId>;
  readonly answer: (operation: AnyOperation) => PolicyDecision;
  readonly signCommits: boolean;
  readonly ownApp: boolean;
}

/** The operations an authority answers that matter: the built-in ones, and those of the Charms it holds. */
const answeredBy = (charms: ReadonlyArray<CharmId>, declared: ReadonlyArray<CharmOperation>) => [
  ...POLICY_OPERATIONS,
  ...declared.filter((operation) => charms.includes(operation.id.split(".")[0] as CharmId)).map((each) => each.id),
];

/** A name or role title the profile would refuse: empty once trimmed, or longer than a name tag takes. */
const labelProblems = (draft: SummoningDraft): ReadonlyArray<string> =>
  (
    [
      ["name", draft.name, "It needs a name."],
      ["role title", draft.role_title, "Its role title cannot be empty."],
    ] as const
  ).flatMap(([words, value, empty]) => {
    if (value === undefined) return [];
    if (value.trim() === "") return [empty];
    return value.trim().length > HOB_LABEL_MAX ? [`Its ${words} is longer than ${HOB_LABEL_MAX} characters.`] : [];
  });

/** Whether a hob could use an operation: every built-in one, and a Charm's only while it holds that Charm. */
const heldBefore = (authority: Authority, operation: AnyOperation) =>
  !isCharmOperation(operation) || authority.charms.includes(operation.split(".")[0] as CharmId);

/**
 * What a change would leave a hob able to do that neither its manager nor the hob itself could
 * before (ADR 034): a shared folder it would see that the manager does not, or an answer wider than
 * both, such as an override a replaced answer map drops, or an operation of a Charm newly granted. A hob already wider is asked about instead.
 */
const escalations = (
  before: Authority,
  after: Authority,
  manager: Authority,
  operations: ReadonlyArray<CharmOperation>,
): ReadonlyArray<string> => [
  ...after.shared
    .filter((folder) => !manager.shared.includes(folder) && !before.shared.includes(folder))
    .map((folder) => `authority-wider: shared folders, since ${folder} is hidden from you.`),
  ...answeredBy(after.charms, operations)
    .filter(
      (operation) =>
        !isNarrowerOrEqual(after.answer(operation), manager.answer(operation)) &&
        // A Charm the hob did not hold gave it none of its operations, whatever their answers read.
        (!heldBefore(before, operation) || !isNarrowerOrEqual(after.answer(operation), before.answer(operation))),
    )
    .map((operation) => `authority-wider: answers, since ${operation} would be wider than your own.`),
];

/** One row of a call, as it is checked: the hob it names and what is wrong with it, or what it asks. */
interface Row {
  readonly label: string;
  readonly problems: ReadonlyArray<string>;
  readonly asks: ReadonlyArray<string>;
}

const rowText = (row: Row) =>
  row.problems.length > 0
    ? `- ${row.label}: ${row.problems.join(" ")}`
    : `- ${row.label}: ready.${row.asks.length === 0 ? " Nothing asks the user." : ` It would ask the user about ${row.asks.join(", ")}.`}`;

/** The Summoning Charm, ready to register with `Charms.layer`. */
export const makeSummoningCharm = (options: { readonly decide: DecideSummoning; readonly separator: string }) =>
  Effect.gen(function* () {
    const hub = yield* SummoningHub;
    const { decide, separator } = options;
    const declared = SUMMONING_CHARM.operations;

    // One lock per manager and one per Task tree, held while unattended summons are counted and
    // stored, so two summons at once, by one manager or by two in one tree, never both take the last
    // place under a cap (ADR 034). A manager's lock is always taken before its tree's, so they never
    // wait on each other in a cycle.
    const capLocks = new Map<string, Semaphore.Semaphore>();
    const underLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => {
      let lock = capLocks.get(key);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        capLocks.set(key, lock);
      }
      return Semaphore.withPermit(lock, effect);
    };
    const underCapLocks = <A, E, R>(managerId: AgentId, root: TaskId | null, effect: Effect.Effect<A, E, R>) =>
      underLock(`hob:${managerId}`, root === null ? effect : underLock(`tree:${root}`, effect));

    /** The top Task of the tree `taskId` is in, or the Task itself when the hub has no record of it. */
    const rootOf = (services: SummoningServices, taskId: TaskId | null) =>
      taskId === null
        ? Effect.succeed(null)
        : Effect.map(services.tasks.readTree(taskId), (tree) =>
            Option.isSome(tree) ? (tree.value.tasks.find((task) => task.id === taskId)?.rootId ?? taskId) : taskId,
          );

    /** Every Task of the tree under `root`, its root and every sibling included. */
    const treeTasks = (services: SummoningServices, root: TaskId) =>
      Effect.map(
        services.tasks.readTree(root),
        (tree) => new Set<string>(Option.isSome(tree) ? tree.value.tasks.map((task) => task.id) : [root]),
      );

    /**
     * Why `adding` more unattended summons would pass a cap, read now: the manager's live hobs summoned
     * without a card, and those of the whole tree under `root`, against the limits; null while there
     * is room (ADR 034).
     */
    const capReached = (services: SummoningServices, managerId: AgentId, root: TaskId | null, adding: number) =>
      Effect.gen(function* () {
        const agents = yield* services.repo.listAgents;
        const { maxUnattendedPerHob, maxUnattendedPerTree } = services.limits;
        const byManager = unattendedSummonsBy(agents, managerId);
        if (byManager + adding > maxUnattendedPerHob) {
          return `You have ${byManager} live ${byManager === 1 ? "hob" : "hobs"} summoned without asking the user, and the cap is ${maxUnattendedPerHob}, so this summon asks the user.`;
        }
        if (root === null) return null;
        const inTree = unattendedSummonsIn(agents, yield* treeTasks(services, root));
        if (inTree + adding > maxUnattendedPerTree) {
          return `This work has ${inTree} live ${inTree === 1 ? "hob" : "hobs"} summoned without asking the user, and the cap is ${maxUnattendedPerTree}, so this summon asks the user.`;
        }
        return null;
      });

    /** A hob's policy as its turns run under it, with "Summoning for every hob" applied. */
    const effectivePolicy = (agent: Agent, services: SummoningServices) =>
      Effect.map(services.setup.get, (setup) => withSummoningForEveryHob(agent, setup.summoningForEveryHob));

    /** The authority of a hob under `policy`, as its turns read it. */
    const authorityOf = (
      agentId: AgentId,
      hob: HobPolicy,
      base: Pick<ToolPolicy, "preset" | "sharedFolders" | "charmOperations">,
      services: SummoningServices,
    ) =>
      Effect.gen(function* () {
        const hidden = new Set(yield* Effect.forEach(hob.hiddenSharedFolders, services.folders.identity));
        const shared = (yield* Effect.forEach(base.sharedFolders, services.folders.identity)).filter(
          (folder) => !hidden.has(folder),
        );
        const app = Option.isSome(services.apps) ? yield* services.apps.value.get(agentId) : null;
        const policy = { ...base, hob, restrictions: [] };
        return {
          ownFolders: hob.ownFolders,
          shared,
          charms: heldCharms(hob),
          answer: (operation: AnyOperation) => operationDecision(policy, operation),
          signCommits: hob.signCommits === true,
          ownApp: app !== null,
        } satisfies Authority;
      });

    /** The manager's authority, from the access its call runs under. */
    const managerAuthority = (context: HubPlanContext, services: SummoningServices) =>
      Effect.gen(function* () {
        const { policy } = context.access;
        const authority = yield* authorityOf(context.turn.agentId, policy.hob, policy, services);
        // A restriction a delegation added narrows the manager too (ADR 018).
        return { ...authority, answer: (operation: AnyOperation) => operationDecision(policy, operation) };
      });

    const within = (folder: string, manager: Authority) =>
      manager.ownFolders.some((own) => holdsPath(own, folder, separator));

    /**
     * The fields in which `target` is wider than `manager`, or none when it is within (ADR 034), with
     * `operations` the Charm operations the hub declares.
     */
    const widerFields = (
      target: Authority,
      manager: Authority,
      operations: ReadonlyArray<CharmOperation>,
    ): ReadonlyArray<string> => {
      const wider: Array<string> = [];
      if (target.ownFolders.some((folder) => !within(folder, manager))) wider.push("folders");
      if (target.shared.some((folder) => !manager.shared.includes(folder))) wider.push("shared folders");
      if (target.charms.some((charm) => charm === SUMMONING_CHARM_ID || !manager.charms.includes(charm))) {
        wider.push("Charms");
      }
      const answered = answeredBy(target.charms, operations);
      if (answered.some((operation) => !isNarrowerOrEqual(target.answer(operation), manager.answer(operation)))) {
        wider.push("operation answers");
      }
      if (target.signCommits && !manager.signCommits) wider.push("commit signing");
      if (target.ownApp && !manager.ownApp) wider.push("GitHub identity");
      return wider;
    };

    /** The Charm operations the hub declares, as the call's policy reads them. */
    const operationsOf = (context: HubPlanContext) => context.access.policy.charmOperations ?? declared;

    /** The hobs a reference names: by id first, then by name ignoring case and spaces; never a retired one by name. */
    const resolve = (agents: ReadonlyArray<Agent>, named: string) => {
      const byId = agents.filter((agent) => agent.id === named.trim());
      if (byId.length > 0) return byId;
      const wanted = named.trim().toLowerCase();
      return agents.filter((agent) => agent.status !== "retired" && agent.name.trim().toLowerCase() === wanted);
    };

    /** The target hob a call names, within the manager's scope, or why it cannot be managed. */
    const target = (
      agents: ReadonlyArray<Agent>,
      manager: { readonly id: AgentId; readonly policy: HobPolicy },
      named: string,
    ): { readonly agent: Agent; readonly self: boolean } | string => {
      const found = resolve(agents, named);
      if (found.length === 0) return `There is no hob named ${named}.`;
      if (found.length > 1) {
        return `Several hobs are named ${named}: name one by its id (${found.map((agent) => agent.id).join(", ")}).`;
      }
      const agent = found[0] as Agent;
      const scope = summoningScopeOf(manager.policy);
      if (agent.id === manager.id) {
        return scope.self ? { agent, self: true } : `${agent.name} is you, and you cannot manage yourself.`;
      }
      if (agent.status === "retired") return `${agent.name} is retired, so it is outside every scope.`;
      const inScope = (scope.summoned && agent.summonedBy === manager.id) || scope.hobs.includes(agent.id);
      return inScope ? { agent, self: false } : `${agent.name} is outside your Summoning scope.`;
    };

    /** The Charm request of one operation. */
    const part = (operation: CharmOperationId, targets: ReadonlyArray<string>): SummoningPolicyRequest => ({
      _tag: "Charm",
      charm: SUMMONING_CHARM_ID,
      operation,
      site: {},
      targets,
    });

    const wordsOf = (operation: CharmOperationId) => declared.find((each) => each.id === operation)?.words ?? operation;

    /** Problems with the folders a draft or change gives: own folders within the manager's, hidden ones shared. */
    const folderProblems = (
      draft: SummoningDraft,
      manager: Authority,
      services: SummoningServices,
      shared: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const problems: Array<string> = [];
        for (const folder of draft.own_folders ?? []) {
          const canonical = yield* services.folders.check(folder).pipe(Effect.option);
          if (Option.isNone(canonical)) problems.push(`${folder} is not a folder on this hub.`);
          else if (shared.includes(canonical.value)) problems.push(`${folder} is already shared with every hob.`);
          else if (!within(canonical.value, manager)) {
            problems.push(`authority-wider: folders, since ${folder} is not one of your own folders or inside one.`);
          }
        }
        if (draft.hidden_shared_folders !== undefined) {
          const isShared = yield* sameFolderIn(services.folders, (yield* services.setup.get).approvedFolders);
          for (const folder of draft.hidden_shared_folders) {
            if (!(yield* isShared(folder))) problems.push(`${folder} is not a shared folder.`);
          }
        }
        return problems;
      });

    /** Problems with the Charms and answers a draft or change gives, against the manager. */
    const grantProblems = (draft: SummoningDraft, manager: Authority): ReadonlyArray<string> => [
      ...(draft.charms ?? []).flatMap((charm) => {
        if (charm === SUMMONING_CHARM_ID) return ["Only the user grants the Summoning Charm."];
        return manager.charms.includes(charm)
          ? []
          : [`authority-wider: charms, since you do not hold the ${charm} Charm.`];
      }),
      ...Object.entries(draft.answers ?? {}).flatMap(([operation, answer]) => {
        if (answer === undefined) return [];
        if (operation.startsWith(`${SUMMONING_CHARM_ID}.`))
          return ["Only the user sets the Summoning Charm's answers."];
        return isNarrowerOrEqual(answer, manager.answer(operation as AnyOperation))
          ? []
          : [`authority-wider: answers, since ${operation} would be wider than your own.`];
      }),
    ];

    /** Problems with the folders, Charms and answers a draft or change gives, against the manager (ADR 034). */
    const authorityProblems = (
      draft: SummoningDraft,
      manager: Authority,
      services: SummoningServices,
      shared: ReadonlyArray<string>,
    ) =>
      Effect.map(folderProblems(draft, manager, services, shared), (folders) => [
        ...folders,
        ...grantProblems(draft, manager),
      ]);

    /** Problems with a draft's name, role, good at and brain, as Summon and the profile refuse them. */
    const fieldProblems = (
      draft: SummoningDraft,
      fallback: Pick<Agent, "runtime" | "model" | "effort">,
      services: SummoningServices,
    ) =>
      Effect.gen(function* () {
        const problems: Array<string> = [];
        problems.push(...labelProblems(draft));
        if (draft.role != null && draft.role_title !== undefined) {
          const invalid = checkRole({ role: draft.role, roleTitle: draft.role_title });
          if (invalid !== undefined) problems.push(`${invalid.message}.`);
        }
        const goodAt = checkGoodAt(draft.good_at);
        if (goodAt !== undefined) problems.push(`${goodAt.message}.`);
        if (draft.runtime !== undefined || draft.model !== undefined || draft.effort !== undefined) {
          const brain = yield* checkRuntimeBrain(services.adapters, {
            runtime: draft.runtime ?? fallback.runtime,
            model: draft.model === undefined ? fallback.model : draft.model,
            effort: draft.effort === undefined ? fallback.effort : draft.effort,
          });
          if (brain !== undefined) problems.push(`${brain.message}.`);
        }
        return problems;
      });

    /** The fields of a draft at Never, which refuse it naming each (ADR 034). */
    const neverFields = (
      fields: ReadonlyArray<SummoningField>,
      answer: (operation: AnyOperation) => PolicyDecision,
      self: boolean,
    ) =>
      fields.flatMap((field) => {
        const operation = self ? selfOperation(field) : summoningFieldOperation(field);
        return operation !== null && answer(operation) === "deny"
          ? [`${SUMMONING_FIELD_WORDS[field]} is at Never for you.`]
          : [];
      });

    const selfOperation = (field: SummoningField): CharmOperationId | null => {
      const self = SELF_FIELD_OF[field];
      return self === null ? null : selfFieldOperation(self);
    };

    /** What a summon draft lacks, or gets wrong, against the manager. */
    const checkDraft = (
      draft: SummoningDraft,
      manager: Authority & { readonly agent: Agent },
      services: SummoningServices,
      shared: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const problems: Array<string> = [];
        if (draft.name === undefined) problems.push("It needs a name.");
        if (draft.role == null && draft.role_title === undefined) {
          problems.push("It needs a role: a starter role or a title in your own words.");
        }
        problems.push(...(yield* fieldProblems(draft, manager.agent, services)));
        problems.push(...neverFields(fieldsSet(draft), manager.answer, false));
        problems.push(...(yield* authorityProblems(draft, manager, services, shared)));
        const asks = [SUMMON_OPERATION].filter((operation) => manager.answer(operation) === "ask").map(wordsOf);
        return { label: draft.name?.trim() || "A new hob", problems, asks } satisfies Row;
      });

    /** A checked change: its target and the operations it is decided on, or what is wrong with it. */
    const checkChange = (
      change: SummoningChange,
      manager: Authority & { readonly agent: Agent; readonly policy: HobPolicy },
      agents: ReadonlyArray<Agent>,
      context: HubPlanContext,
      services: SummoningServices,
    ) =>
      Effect.gen(function* () {
        const found = target(agents, { id: manager.agent.id, policy: manager.policy }, change.hob);
        if (typeof found === "string") {
          const code = found.startsWith("There is no") || found.startsWith("Several") ? "unknown-hob" : "outside-scope";
          return { row: { label: change.hob, problems: [`${code}: ${found}`], asks: [] }, found: null } as const;
        }
        const { agent, self } = found;
        const fields = fieldsSet(change);
        const problems: Array<string> = [];
        if (fields.length === 0) problems.push("It names no field to change.");
        const operations: Array<CharmOperationId> = [];
        for (const field of fields) {
          const operation = self ? selfOperation(field) : summoningFieldOperation(field);
          if (operation === null) {
            problems.push(`outside-scope: managing yourself, you may never change ${SUMMONING_FIELD_WORDS[field]}.`);
          } else if (!operations.includes(operation)) operations.push(operation);
        }
        problems.push(...neverFields(fields, manager.answer, self));
        const policy = yield* effectivePolicy(agent, services);
        problems.push(...(yield* fieldProblems(change, agent, services)));
        if (!self) {
          const shared = context.access.policy.sharedFolders;
          problems.push(...(yield* authorityProblems(change, manager, services, shared)));
        }
        const authority = yield* authorityOf(agent.id, policy, context.access.policy, services);
        if (!self) {
          const permissions = permissionsPayload(change, agent.policy);
          if (permissions !== null) {
            const after = yield* effectivePolicy(
              new Agent({ ...agent, policy: changedPolicy(agent.policy, permissions) }),
              services,
            );
            const resulting = yield* authorityOf(agent.id, after, context.access.policy, services);
            problems.push(...escalations(authority, resulting, manager, operationsOf(context)));
          }
        }
        const wider = self ? [] : widerFields(authority, manager, operationsOf(context));
        const safety =
          wider.length === 0
            ? null
            : `${agent.name} can do more than you (${wider.join(", ")}), so every change to it asks the user.`;
        const asks =
          safety === null
            ? operations.filter((operation) => manager.answer(operation) === "ask").map(wordsOf)
            : ["every field, since it can do more than you"];
        return {
          row: { label: agent.name, problems, asks } satisfies Row,
          found: { agent, self, operations, safety, policy },
        } as const;
      });

    /** What the services and the manager are for a call. */
    const prepare = (context: HubPlanContext) =>
      Effect.gen(function* () {
        const services = yield* hub.services;
        const agent = yield* services.repo.findAgent(context.turn.agentId);
        if (Option.isNone(agent)) return yield* refused("unknown-hob", "Hobbots cannot find you on this hub.");
        const authority = yield* managerAuthority(context, services);
        const agents = yield* services.repo.listAgents;
        return {
          services,
          agents,
          manager: { ...authority, agent: agent.value, policy: context.access.policy.hob },
        };
      });

    /** Who made a change: the manager, under an Allow, with its call (ADR 034). */
    const actorOf = (context: HubPlanContext): ChangeActor => ({
      _tag: "Hob",
      hobId: context.turn.agentId,
      call: { scope: context.turn.scope(), key: context.key ?? "" },
    });

    const taskOf = (context: HubPlanContext): TaskId | null => {
      const scope = context.turn.scope();
      return scope.startsWith("task:") ? (scope.slice("task:".length) as TaskId) : null;
    };

    const request = (
      operation: CharmOperationId,
      parts: ReadonlyArray<SummoningPolicyRequest>,
      safety: string | null = null,
    ): SummoningRequest => ({ _tag: "Charm", charm: SUMMONING_CHARM_ID, operation, parts, safety });

    /** The answers a summoned hob gets: the narrower of the draft's and the manager's, for every operation. */
    const summonedAnswers = (
      draft: SummoningDraft,
      manager: Authority,
      charms: ReadonlyArray<CharmId>,
      operations: ReadonlyArray<CharmOperation>,
    ) => {
      const builtIn: Record<string, PolicyDecision> = {};
      const charm: Record<string, PolicyDecision> = {};
      for (const operation of answeredBy(charms, operations)) {
        const asked = (draft.answers as PolicyLayer | undefined)?.[operation];
        const answer = asked === undefined ? manager.answer(operation) : narrowest(asked, manager.answer(operation));
        if (answer === "allow") continue;
        (isCharmOperation(operation) ? charm : builtIn)[operation] = answer;
      }
      return { builtIn: builtIn as PolicyOverrides, charm: charm as CharmOverrides };
    };

    const colors = HobColor.literals;

    /** A draft with its look drawn, when it leaves the look to Summon. */
    const pinnedLook = (draft: SummoningDraft): SummoningDraft => {
      if (draft.look_seed !== undefined && draft.look_color !== undefined) return draft;
      const lookSeed = draft.look_seed ?? Math.floor(Math.random() * 2 ** 32);
      return {
        ...draft,
        look_seed: lookSeed,
        look_color: draft.look_color ?? (colors[lookSeed % colors.length] as HobColor),
      };
    };

    /** The fields given a value, so one left out stays out of the request. */
    const defined = (fields: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

    /** A summon draft as Summon's request, with what it leaves out filled with Summon's defaults. */
    const createPayload = (draft: SummoningDraft, id: AgentId, manager: Agent, seed: number): CreateAgentPayload => {
      const role = draft.role ?? null;
      const lookSeed = draft.look_seed ?? seed;
      return {
        id,
        name: (draft.name ?? "").trim(),
        role,
        roleTitle: (draft.role_title ?? (role === null ? "" : starterRole(role).title)).trim(),
        sigil: draft.sigil ?? role ?? DEFAULT_SIGIL,
        hat: draft.hat ?? null,
        tool: draft.tool ?? null,
        ...defined({ goodAt: draft.good_at, voice: draft.voice, length: draft.length }),
        lookSeed,
        lookColor: draft.look_color ?? (colors[lookSeed % colors.length] as HobColor),
        runtime: draft.runtime ?? manager.runtime,
        model: draft.model ?? null,
        effort: draft.effort ?? null,
        instructions: draft.instructions ?? "",
      };
    };

    /** A change's profile fields, as the profile's edit. */
    const updatePayload = (change: SummoningChange): UpdateAgentPayload => {
      const fields: Record<string, unknown> = {
        name: change.name?.trim(),
        role: change.role,
        roleTitle: change.role_title?.trim(),
        goodAt: change.good_at,
        sigil: change.sigil,
        hat: change.hat,
        tool: change.tool,
        lookSeed: change.look_seed,
        lookColor: change.look_color,
        voice: change.voice,
        length: change.length,
        instructions: change.instructions,
        runtime: change.runtime,
        model: change.model,
        effort: change.effort,
      };
      return defined(fields) as UpdateAgentPayload;
    };

    /** A change's folders, Charms and answers, as the Charms tab's change, never touching the Summoning Charm. */
    const permissionsPayload = (change: SummoningChange, target: HobPolicy): UpdateHobPermissionsPayload | null => {
      const keys = [...DRAFT_FIELDS.folders, ...DRAFT_FIELDS.charms];
      if (keys.every((key) => change[key] === undefined)) return null;
      const answers = change.answers as PolicyLayer | undefined;
      const builtIn =
        answers && Object.fromEntries(Object.entries(answers).filter(([op]) => !isCharmOperation(op as AnyOperation)));
      const charmAnswers =
        answers && Object.fromEntries(Object.entries(answers).filter(([op]) => isCharmOperation(op as AnyOperation)));
      // The Summoning Charm's own grant and answers are yours alone, so a change keeps them.
      const summoning = Object.fromEntries(
        Object.entries(target.charms?.overrides ?? {}).filter(([op]) => op.startsWith(`${SUMMONING_CHARM_ID}.`)),
      );
      const keepsSummoning = holdsCharm(target, SUMMONING_CHARM_ID);
      const granted = change.charms && [...change.charms, ...(keepsSummoning ? [SUMMONING_CHARM_ID] : [])];
      const charms =
        granted === undefined && charmAnswers === undefined
          ? undefined
          : {
              ...(granted === undefined ? {} : { granted }),
              ...(charmAnswers === undefined ? {} : { overrides: { ...charmAnswers, ...summoning } as CharmOverrides }),
            };
      return defined({
        ownFolders: change.own_folders,
        hiddenSharedFolders: change.hidden_shared_folders,
        overrides: builtIn as PolicyOverrides | undefined,
        charms,
      }) as UpdateHobPermissionsPayload;
    };

    const card = (input: object, summary: string) => ({ arguments: { ...input }, summary });

    const describeHob = (agent: Agent) =>
      `- ${agent.name} (${agent.roleTitle}), id ${agent.id}: open it at ${hobProfilePath(agent.id)}`;

    const failure = (error: unknown) =>
      typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);

    const check = hubAction<(typeof SummoningInputs)[typeof SUMMONING_CHECK_TOOL], SummoningRequest>({
      tool: tool(SUMMONING_CHECK_TOOL),
      input: SummoningInputs[SUMMONING_CHECK_TOOL],
      effect: "read",
      otherwise: "no draft was checked",
      plan: (input, context) =>
        Effect.gen(function* () {
          const { services, agents, manager } = yield* prepare(context);
          const shared = context.access.policy.sharedFolders;
          const rows: Array<string> = [];
          for (const draft of input.summon ?? [])
            rows.push(rowText(yield* checkDraft(draft, manager, services, shared)));
          for (const change of input.change ?? []) {
            rows.push(rowText((yield* checkChange(change, manager, agents, context, services)).row));
          }
          const drafts = input.summon?.length ?? 0;
          if (drafts > 0 && manager.answer(SUMMON_OPERATION) === "allow") {
            const root = yield* rootOf(services, taskOf(context));
            const cap = yield* capReached(services, manager.agent.id, root, drafts);
            if (cap !== null) rows.push(`- Summoning them: ${cap}`);
          }
          const text =
            rows.length === 0
              ? "Give drafts of new hobs under summon, or of changes under change, to check them."
              : `Checked; nothing was changed.\n${rows.join("\n")}`;
          return { _tag: "NoCall", text } as const;
        }),
    });

    /** Who made a change you applied from a proposal: you, on the manager's proposal and its call (ADR 034). */
    const appliedActor = (proposal: HobProposal): ChangeActor => ({
      _tag: "YouApplyingProposal",
      hobId: proposal.agentId,
      proposalId: proposal.id,
      call: proposal.call,
    });

    /** Summons one hob from a draft, as `actor`, never wider than the manager. */
    const summonOne = (
      draft: SummoningDraft,
      id: AgentId,
      manager: Authority & { readonly agent: Agent },
      context: HubPlanContext,
      services: SummoningServices,
      made: { readonly actor: ChangeActor; readonly unattended: boolean },
    ) =>
      Effect.gen(function* () {
        const shared = context.access.policy.sharedFolders;
        const hiddenShared = shared.filter((folder) => !manager.shared.includes(folder));
        const charms = (draft.charms ?? []).filter((charm) => charm !== SUMMONING_CHARM_ID);
        const answers = summonedAnswers(draft, manager, charms, operationsOf(context));
        const ownFolders = yield* Effect.forEach(draft.own_folders ?? [], (folder) =>
          services.folders.check(folder),
        ).pipe(Effect.orDie);
        const hidden = yield* Effect.forEach(
          [...(draft.hidden_shared_folders ?? []), ...hiddenShared],
          services.folders.identity,
        );
        const policy: HobPolicy = {
          ownFolders: [...new Set(ownFolders)],
          hiddenSharedFolders: [...new Set(hidden)],
          overrides: answers.builtIn,
          charms: {
            granted: charms,
            ...(Object.keys(answers.charm).length === 0 ? {} : { overrides: answers.charm }),
          },
        };
        const seed = Math.floor(Math.random() * 2 ** 32);
        const payload = createPayload(draft, id, manager.agent, seed);
        return yield* services.hobs
          .create(payload, { actor: made.actor, taskId: taskOf(context), unattended: made.unattended, policy })
          .pipe(Effect.mapError((error) => `- ${payload.name}: ${failure(error)}`));
      });

    /** Changes one hob as `actor`: its profile and permissions as one version (ADR 034). */
    const changeOne = (agent: Agent, each: SummoningChange, services: SummoningServices, actor: ChangeActor) => {
      const profile = updatePayload(each);
      const permissions = permissionsPayload(each, agent.policy);
      // Profile and permissions are one version, so a change either part refuses stores nothing.
      const write = services.hobs.change(
        agent.id,
        {
          ...(Object.keys(profile).length === 0 ? {} : { profile }),
          ...(permissions === null ? {} : { permissions }),
        },
        actor,
      );
      return (permissions === null ? write : services.changePermissions(agent.id, write)).pipe(
        Effect.mapError((error) => `- ${agent.name}: ${failure(error)}`),
      );
    };

    /**
     * Records a call that asked as a proposal and waits for you to decide it (ADR 034). What you
     * allowed is the call's answer, row by row; a proposal you denied whole is refused.
     */
    const proposing =
      (
        context: HubPlanContext,
        kind: HobProposalKind,
        tool: SummoningToolName,
        made: {
          readonly rows: ReadonlyArray<HobProposalRow>;
          readonly asks: ReadonlyArray<CharmOperationId>;
          readonly safety: string | null;
        },
      ) =>
      (asked: { readonly stepId: string | null; readonly waiting: (proposalId: string) => void }) =>
        Effect.gen(function* () {
          const services = yield* hub.services;
          const { proposal, settled } = yield* services.proposals.propose({
            agentId: context.turn.agentId,
            kind,
            tool,
            call: { scope: context.turn.scope(), key: context.key ?? "" },
            threadId: context.turn.threadId,
            messageId: context.turn.messageId,
            taskId: taskOf(context),
            stepId: asked.stepId,
            rows: made.rows,
            // "Always allow" never covers a safety Ask or a high-risk operation.
            asks: made.safety === null ? made.asks.filter((operation) => operation !== RETIRE_OPERATION) : [],
            safety: made.safety,
            highRisk: kind === "retire",
          });
          asked.waiting(proposal.id);
          const outcome = yield* settled;
          const text = hobProposalOutcomeText(outcome);
          return outcome.rows.some((row) => row.state === "allowed")
            ? ({ _tag: "Applied", text } as const)
            : ({ _tag: "Refused", text } as const);
        });

    /** The operations among `operations` that ask the manager. */
    const askingOf = (manager: Authority, operations: ReadonlyArray<CharmOperationId>) =>
      operations.filter((operation) => manager.answer(operation) === "ask");

    /** A target's value of each field a change gives, by the change's own field name, as its card shows before. */
    const beforeOf = (agent: Agent, change: SummoningChange): Record<string, unknown> => {
      const current: Record<string, unknown> = {
        name: agent.name,
        role: agent.role,
        role_title: agent.roleTitle,
        good_at: agent.goodAt,
        sigil: agent.sigil,
        hat: agent.hat,
        tool: agent.tool,
        look_seed: agent.lookSeed,
        look_color: agent.lookColor,
        voice: agent.voice,
        length: agent.length,
        instructions: agent.instructions,
        runtime: agent.runtime,
        model: agent.model,
        effort: agent.effort,
        own_folders: agent.policy.ownFolders,
        hidden_shared_folders: agent.policy.hiddenSharedFolders,
        charms: heldCharms(agent.policy),
        answers: { ...agent.policy.overrides, ...agent.policy.charms?.overrides },
      };
      return Object.fromEntries(
        Object.keys(change)
          .filter((key) => key !== "hob" && change[key as keyof SummoningChange] !== undefined)
          .map((key) => [key, current[key] ?? null]),
      );
    };

    /** Whether `holds` for every hob the call's plan recorded, read from the hub's own records. */
    const everyPlanned = (
      call: CharmCall,
      holds: (services: SummoningServices, id: AgentId) => Effect.Effect<boolean>,
    ) =>
      Effect.gen(function* () {
        const services = yield* hub.services;
        const { ids } = JSON.parse(call.plan) as { readonly ids: ReadonlyArray<AgentId> };
        for (const id of ids) if (!(yield* holds(services, id))) return false;
        return true;
      });

    /** Whether hob `id` has a configuration version that `call` made, since the call began. */
    const madeByCall = (services: SummoningServices, id: AgentId, call: CharmCall) =>
      Effect.gen(function* () {
        const agent = yield* services.repo.findAgent(id);
        if (Option.isNone(agent)) return false;
        for (let version = agent.value.configVersion; version >= 1; version--) {
          const config = yield* services.repo.findAgentConfig(id, version);
          if (Option.isNone(config) || config.value.createdAt < call.createdAt) return false;
          const { actor } = config.value;
          if (actor._tag !== "You" && actor.hobId === call.agentId && actor.call.key === call.key) return true;
        }
        return false;
      });

    const summon = hubAction({
      tool: tool("summoning_summon"),
      input: SummoningInputs.summoning_summon,
      effect: "write",
      otherwise: "no hob was summoned",
      readBack: (call: CharmCall) =>
        everyPlanned(call, (services, id) => Effect.map(services.repo.findAgent(id), Option.isSome)),
      plan: (input, context) =>
        Effect.gen(function* () {
          const { services, manager } = yield* prepare(context);
          const shared = context.access.policy.sharedFolders;
          const rows = yield* Effect.forEach(input.hobs, (draft) => checkDraft(draft, manager, services, shared));
          const wrong = rows.filter((row) => row.problems.length > 0);
          if (wrong.length > 0) {
            return yield* new HubRefusal({ message: `No hob was summoned.\n${wrong.map(rowText).join("\n")}` });
          }
          const ids = input.hobs.map(() => AgentId.make(crypto.randomUUID()));
          const managerId = manager.agent.id;
          const taskId = taskOf(context);
          const root = yield* rootOf(services, taskId);
          const withoutCard = manager.answer(SUMMON_OPERATION) === "allow";
          // At a cap the summon asks instead of being refused, and one you approve is never counted.
          const cap = withoutCard ? yield* capReached(services, managerId, root, input.hobs.length) : null;
          const unattended = withoutCard && cap === null;
          const actor = actorOf(context);
          const names = input.hobs.map((draft) => (draft.name ?? "").trim());
          const create = Effect.gen(function* () {
            // Counted again under the manager's and the tree's locks: another summon may have taken the last place.
            const taken = unattended ? yield* capReached(services, managerId, root, input.hobs.length) : null;
            if (taken !== null) {
              const text = `No hob was summoned: another summon reached the cap meanwhile. Call again and it will ask the user. ${taken}`;
              return { _tag: "Refused", text } as const;
            }
            const created: Array<Agent> = [];
            const failed: Array<string> = [];
            for (const [index, draft] of input.hobs.entries()) {
              const hob = yield* summonOne(draft, ids[index] as AgentId, manager, context, services, {
                actor,
                unattended,
              }).pipe(Effect.result);
              if (hob._tag === "Success") created.push(hob.success);
              else failed.push(hob.failure);
            }
            if (created.length === 0)
              return { _tag: "Refused", text: `No hob was summoned.\n${failed.join("\n")}` } as const;
            const text = [
              `Summoned ${created.length === 1 ? "1 hob" : `${created.length} hobs`}:`,
              ...created.map(describeHob),
              ...(failed.length === 0 ? [] : ["These could not be summoned:", ...failed]),
            ].join("\n");
            return { _tag: "Applied", text } as const;
          });
          const send = underCapLocks(managerId, root, create);
          const proposalRows = input.hobs.map((draft, index) =>
            pendingRow({
              id: String(index + 1),
              hobId: ids[index] as AgentId,
              label: names[index] ?? "",
              // The look is drawn now, so the card shows the hob that allowing it makes.
              draft: pinnedLook(draft),
              change: null,
              before: null,
              configVersion: null,
              status: null,
              runningReplies: null,
            }),
          );
          return {
            request: request(SUMMON_OPERATION, [part(SUMMON_OPERATION, names)], cap),
            card: card(input, `Summon ${names.join(", ")}`),
            write: {
              site: `summon:${context.turn.agentId}`,
              recorded: { ids, names },
              appliedText: `Summoned ${names.join(", ")}.`,
              send,
              proposal: proposing(context, "summon", SUMMONING_SUMMON_TOOL, {
                rows: proposalRows,
                asks: askingOf(manager, [SUMMON_OPERATION]),
                safety: cap,
              }),
            },
          };
        }),
    });

    const change = hubAction({
      tool: tool("summoning_change"),
      input: SummoningInputs.summoning_change,
      effect: "write",
      otherwise: "no hob was changed",
      // Each changed hob holds a version this call made, so the hub's own records say whether it landed.
      readBack: (call: CharmCall) => everyPlanned(call, (services, id) => madeByCall(services, id, call)),
      plan: (input, context) =>
        Effect.gen(function* () {
          const { services, agents, manager } = yield* prepare(context);
          const checked = yield* Effect.forEach(input.changes, (each) =>
            checkChange(each, manager, agents, context, services),
          );
          const wrong = checked.filter((each) => each.row.problems.length > 0);
          if (wrong.length > 0) {
            return yield* new HubRefusal({
              message: `No hob was changed.\n${wrong.map((each) => rowText(each.row)).join("\n")}`,
            });
          }
          const rows = checked.flatMap((each) => (each.found === null ? [] : [each.found]));
          const ids = rows.map((row) => row.agent.id);
          if (new Set(ids).size !== ids.length) {
            return yield* new HubRefusal({ message: "Name each hob once, with all of its fields in one change." });
          }
          const parts = rows.flatMap((row) => row.operations.map((operation) => part(operation, [row.agent.name])));
          const safety = rows.flatMap((row) => (row.safety === null ? [] : [row.safety])).join(" ") || null;
          const actor = actorOf(context);
          const send = Effect.gen(function* () {
            const done: Array<string> = [];
            const failed: Array<string> = [];
            for (const [index, row] of rows.entries()) {
              const each = input.changes[index] as SummoningChange;
              const applied = yield* changeOne(row.agent, each, services, actor).pipe(Effect.result);
              if (applied._tag === "Success") done.push(`- ${row.agent.name}: changed ${fieldsSet(each).join(", ")}.`);
              else failed.push(applied.failure);
            }
            if (done.length === 0)
              return { _tag: "Refused", text: `No hob was changed.\n${failed.join("\n")}` } as const;
            const text = [
              "Changed, from each hob's next turn:",
              ...done,
              ...(failed.length === 0 ? [] : ["These could not be changed:", ...failed]),
            ].join("\n");
            return { _tag: "Applied", text } as const;
          });
          const proposalRows = rows.map((row, index) => {
            const each = input.changes[index] as SummoningChange;
            return pendingRow({
              id: String(index + 1),
              hobId: row.agent.id,
              label: row.agent.name,
              draft: null,
              // The row names its hob by id, so a rename meanwhile never sends it to another.
              change: { ...each, hob: row.agent.id },
              before: beforeOf(row.agent, each),
              configVersion: row.agent.configVersion,
              status: row.agent.status,
              runningReplies: null,
            });
          });
          return {
            request: request(parts[0]?.operation ?? summoningFieldOperation("name"), parts, safety),
            card: card(input, `Change ${rows.map((row) => row.agent.name).join(", ")}`),
            write: {
              site: `change:${[...ids].sort().join(",")}`,
              recorded: { ids },
              appliedText: `Changed ${rows.map((row) => row.agent.name).join(", ")}.`,
              send,
              proposal: proposing(context, "change", SUMMONING_CHANGE_TOOL, {
                rows: proposalRows,
                asks: [...new Set(rows.flatMap((row) => askingOf(manager, row.operations)))],
                safety,
              }),
            },
          };
        }),
    });

    /** What a pause, wake or retire does to its hob, as `actor`. */
    const lifecycleRun = (
      name: LifecycleTool,
      services: SummoningServices,
      agent: Agent,
      runningReplies: "finish" | "stop",
      actor: ChangeActor,
    ) => {
      switch (name) {
        case "summoning_pause":
          return services.lifecycle.pause(agent.id, actor);
        case "summoning_wake":
          return services.lifecycle.wake(agent.id, actor);
        default:
          return services.lifecycle.retire(agent.id, runningReplies, actor);
      }
    };

    /**
     * The hob a pause, wake or retire names, within the manager's scope as it is now, never itself,
     * and with the operation not at Never; or why not. The plan and the applier both read it, so a
     * proposal you allow after its scope or answer narrowed is refused (ADR 034, Applying re-checks).
     */
    const lifecycleTarget = (
      name: LifecycleTool,
      agents: ReadonlyArray<Agent>,
      manager: Authority & { readonly agent: Agent; readonly policy: HobPolicy },
      named: string,
    ) => {
      const found = target(agents, { id: manager.agent.id, policy: manager.policy }, named);
      if (typeof found === "string") {
        const code = found.startsWith("There is no") || found.startsWith("Several") ? "unknown-hob" : "outside-scope";
        return { _tag: "Refused", code, text: found } as const;
      }
      if (found.self) {
        return {
          _tag: "Refused",
          code: "outside-scope",
          text: `You never ${LIFECYCLE[name].verb.replace(/d$/, "")} yourself.`,
        } as const;
      }
      const operation = name === "summoning_retire" ? RETIRE_OPERATION : PAUSE_OPERATION;
      if (manager.answer(operation) === "deny") {
        return { _tag: "Refused", code: "never", text: `${wordsOf(operation)} is at Never for you.` } as const;
      }
      return { _tag: "Found", agent: found.agent, operation } as const;
    };

    /** Pause, wake or retire one hob within the scope, never the manager itself. */
    const lifecycleAction = (name: LifecycleTool) => {
      const { verb, status, kind } = LIFECYCLE[name];
      return hubAction({
        tool: tool(name),
        input: SummoningInputs[name] as typeof SummoningInputs.summoning_pause,
        effect: "write",
        otherwise: `no hob was ${verb}`,
        readBack: (call: CharmCall) =>
          Effect.gen(function* () {
            const services = yield* hub.services;
            const { id } = JSON.parse(call.plan) as { readonly id: AgentId };
            const agent = yield* services.repo.findAgent(id);
            return Option.isSome(agent) && agent.value.status === status;
          }),
        plan: (input: { readonly hob: string; readonly running_replies?: "finish" | "stop" }, context) =>
          Effect.gen(function* () {
            const { services, agents, manager } = yield* prepare(context);
            const found = lifecycleTarget(name, agents, manager, input.hob);
            if (found._tag === "Refused") return yield* refused(found.code, found.text);
            const { operation } = found;
            const policy = yield* effectivePolicy(found.agent, services);
            const authority = yield* authorityOf(found.agent.id, policy, context.access.policy, services);
            const wider = widerFields(authority, manager, operationsOf(context));
            const safety =
              wider.length === 0
                ? null
                : `${found.agent.name} can do more than you (${wider.join(", ")}), so this asks the user.`;
            const actor = actorOf(context);
            const agent = found.agent;
            const runningReplies = input.running_replies ?? "finish";
            return {
              request: request(operation, [part(operation, [agent.name])], safety),
              card: card(input, `${verb.charAt(0).toUpperCase()}${verb.slice(1, -1)} ${agent.name}`),
              write: {
                site: `hob:${agent.id}`,
                recorded: { id: agent.id, status },
                appliedText: `${agent.name} is ${status} now.`,
                send: lifecycleRun(name, services, agent, runningReplies, actor).pipe(
                  Effect.map((after) => ({ _tag: "Applied", text: `${after.name} is ${after.status} now.` }) as const),
                  Effect.catch((error) => Effect.succeed({ _tag: "Refused", text: failure(error) } as const)),
                ),
                proposal: proposing(context, kind, name, {
                  rows: [
                    pendingRow({
                      id: "1",
                      hobId: agent.id,
                      label: agent.name,
                      draft: null,
                      change: null,
                      before: null,
                      configVersion: agent.configVersion,
                      status: agent.status,
                      runningReplies: name === "summoning_retire" ? runningReplies : null,
                    }),
                  ],
                  asks: askingOf(manager, [operation]),
                  safety,
                }),
              },
            };
          }),
      });
    };

    /** The context a proposal is applied in: the manager's call, under its access as it is now. */
    const applyContext = (proposal: HobProposal) =>
      Effect.gen(function* () {
        const services = yield* hub.services;
        const access = yield* services.access(proposal.agentId);
        if (access === null || !holdsCharm(access.policy.hob, SUMMONING_CHARM_ID)) {
          return yield* new HobProposalRefused({
            proposalId: proposal.id,
            message: "The hob that proposed this no longer holds the Summoning Charm, so nothing was made.",
          });
        }
        const context: HubPlanContext = {
          turn: {
            agentId: proposal.agentId,
            threadId: proposal.threadId,
            messageId: proposal.messageId,
            scope: () => proposal.call.scope,
            ...(proposal.taskId === null ? {} : { taskId: proposal.taskId }),
          },
          access,
          key: proposal.call.key,
        };
        const prepared = yield* prepare(context).pipe(
          Effect.mapError((error) => proposalRefused(proposal, null, error.message)),
        );
        return { ...prepared, context };
      });

    /** Pauses, wakes or retires a row's hob as you, checked again as the call was (ADR 034, Applying re-checks). */
    const applyLifecycle = (
      proposal: HobProposal,
      row: HobProposalRow,
      made: {
        readonly services: SummoningServices;
        readonly agents: ReadonlyArray<Agent>;
        readonly manager: Authority & { readonly agent: Agent; readonly policy: HobPolicy };
        readonly actor: ChangeActor;
      },
    ) =>
      Effect.gen(function* () {
        const refuse = (text: string) => Effect.fail(proposalRefused(proposal, row.id, text));
        if (!made.agents.some((each) => each.id === row.hobId)) {
          return yield* refuse(`There is no hob ${row.label} on this hub any more.`);
        }
        const name = LIFECYCLE_TOOL[proposal.kind as Exclude<HobProposalKind, "summon" | "change">];
        // The scope, and the operation's answer, as they are now.
        const found = lifecycleTarget(name, made.agents, made.manager, row.hobId);
        if (found._tag === "Refused") return yield* refuse(found.text);
        const run = lifecycleRun(name, made.services, found.agent, row.runningReplies ?? "finish", made.actor);
        const done = yield* Effect.result(run);
        return done._tag === "Success"
          ? ({ _tag: "Applied", text: `${done.success.name} is ${done.success.status} now.` } as const)
          : ({ _tag: "Failed", text: failure(done.failure) } as const);
      });

    const applier: HobProposalApplier = {
      apply: (proposal, row, edited) =>
        Effect.gen(function* () {
          const { services, agents, manager, context } = yield* applyContext(proposal);
          const actor = appliedActor(proposal);
          const refuse = (problems: ReadonlyArray<string>) =>
            Effect.fail(proposalRefused(proposal, row.id, problems.join(" ")));
          switch (proposal.kind) {
            case "summon": {
              const draft = edited ?? row.draft;
              if (draft === null) return yield* refuse(["This row has no draft."]);
              if (manager.answer(SUMMON_OPERATION) === "deny") {
                return yield* refuse([`${wordsOf(SUMMON_OPERATION)} is at Never for you.`]);
              }
              // Your version is checked as the manager's was: never wider than the manager.
              const checked = yield* checkDraft(draft, manager, services, context.access.policy.sharedFolders);
              if (checked.problems.length > 0) return yield* refuse(checked.problems);
              const made = yield* summonOne(draft, row.hobId, manager, context, services, {
                actor,
                unattended: false,
              }).pipe(Effect.result);
              return made._tag === "Success"
                ? ({ _tag: "Applied", text: `Summoned ${describeHob(made.success).slice(2)}` } as const)
                : ({ _tag: "Failed", text: made.failure.slice(2) } as const);
            }
            case "change": {
              if (row.change === null) return yield* refuse(["This row has no change."]);
              const checked = yield* checkChange(row.change, manager, agents, context, services);
              if (checked.row.problems.length > 0 || checked.found === null) return yield* refuse(checked.row.problems);
              const made = yield* changeOne(checked.found.agent, row.change, services, actor).pipe(Effect.result);
              return made._tag === "Success"
                ? ({
                    _tag: "Applied",
                    text: `Changed ${fieldsSet(row.change).join(", ")}, from its next turn.`,
                  } as const)
                : ({ _tag: "Failed", text: made.failure.slice(2) } as const);
            }
            default:
              return yield* applyLifecycle(proposal, row, { services, agents, manager, actor });
          }
        }),
      changedSince: (row) =>
        Effect.gen(function* () {
          if (row.configVersion === null && row.status === null) return false;
          const services = yield* hub.services;
          const agent = yield* services.repo.findAgent(row.hobId);
          if (Option.isNone(agent)) return true;
          return agent.value.configVersion !== row.configVersion || agent.value.status !== row.status;
        }),
      alwaysAllow: (proposal, operations) =>
        Effect.gen(function* () {
          const services = yield* hub.services;
          const found = yield* services.repo.findAgent(proposal.agentId);
          if (Option.isNone(found)) {
            return yield* new HobProposalRefused({ proposalId: proposal.id, message: "That hob is not on this hub." });
          }
          const manager = found.value;
          const allowed = Object.fromEntries(operations.map((operation) => [operation, "allow"])) as CharmOverrides;
          const own = holdsCharm(manager.policy, SUMMONING_CHARM_ID);
          const everyHob = own ? null : (yield* services.setup.get).summoningForEveryHob;
          // A change made by you: the manager's own answer for the operation becomes Allow (ADR 034).
          // A manager with the Charm from "Summoning for every hob" gets its own grant from that
          // setting's scope and answers first, as a change on its Charms tab gives it.
          const charms =
            everyHob === null
              ? { overrides: { ...manager.policy.charms?.overrides, ...allowed } }
              : {
                  granted: [...heldCharms(manager.policy), SUMMONING_CHARM_ID],
                  overrides: { ...everyHob.overrides, ...manager.policy.charms?.overrides, ...allowed },
                  summoning: everyHob.scope,
                };
          const changed = yield* services.hobs
            .change(manager.id, { permissions: { charms } }, YOU)
            .pipe(Effect.mapError((error) => proposalRefused(proposal, null, failure(error))));
          return { before: manager.configVersion, after: changed.configVersion };
        }),
      reconcile: (proposal, row) =>
        Effect.gen(function* () {
          const services = yield* hub.services;
          const found = yield* services.repo.findAgent(row.hobId);
          if (Option.isNone(found)) return null;
          const agent = found.value;
          // The hub mints a summon row's hob id, so a hob with it was made by that row.
          if (proposal.kind === "summon") return `Summoned ${describeHob(agent).slice(2)}`;
          // What this proposal made stays in the hob's history with the proposal as its actor,
          // whatever was changed after it.
          const made = (yield* services.changes.forHob(agent.id)).find(
            (change) => change.actor._tag === "YouApplyingProposal" && change.actor.proposalId === proposal.id,
          );
          if (made === undefined) return null;
          if (made._tag === "Status") return `${agent.name} is ${made.status} now.`;
          return row.change === null ? null : `Changed ${fieldsSet(row.change).join(", ")}, from its next turn.`;
        }),
    };
    yield* hub.bindApplier(applier);

    const actions: ReadonlyArray<HubAction<SummoningRequest>> = [
      check,
      summon,
      change,
      lifecycleAction("summoning_pause"),
      lifecycleAction("summoning_wake"),
      lifecycleAction("summoning_retire"),
    ];

    return defineCharm({
      declaration: SUMMONING_CHARM,
      name: SUMMONING_CHARM_NAME,
      // Every write acts on the hub's own records and reads back from them, so a manager working on a
      // Task it was handed summons and changes hobs there too (ADR 034, Finding who can summon).
      writesOutsideChats: true,
      actions,
      // Every operation the call names is decided, and the narrowest answer stands; a target wider
      // than the manager asks on every field, whatever the answers say (ADR 034).
      decide: (approvals, base, summoning: SummoningRequest) => (fresh) =>
        Effect.gen(function* () {
          let verdict: AskableVerdict | null = null;
          for (const each of summoning.parts) {
            const decided = yield* decide(approvals, base, each)(fresh);
            verdict = verdict === null ? decided : narrowerVerdict(verdict, decided);
          }
          const decided = verdict ?? (yield* decide(approvals, base, part(summoning.operation, []))(fresh));
          return summoning.safety === null ? decided : safetyAsk(decided, summoning.safety);
        }),
      // It reaches nothing outside the hub, so it can always act.
      connected: () => Effect.succeed(true),
    }) satisfies Charm;
  });

type LifecycleTool = "summoning_pause" | "summoning_wake" | "summoning_retire";

/** How each lifecycle tool words its effect, the status it leaves, and the kind of proposal it makes. */
const LIFECYCLE: Readonly<
  Record<LifecycleTool, { readonly verb: string; readonly status: Agent["status"]; readonly kind: HobProposalKind }>
> = {
  summoning_pause: { verb: "paused", status: "paused", kind: "pause" },
  summoning_wake: { verb: "woken", status: "active", kind: "wake" },
  summoning_retire: { verb: "retired", status: "retired", kind: "retire" },
};

/** The lifecycle tool behind a pause, wake or retire proposal. */
const LIFECYCLE_TOOL: Readonly<Record<"pause" | "wake" | "retire", LifecycleTool>> = {
  pause: "summoning_pause",
  wake: "summoning_wake",
  retire: "summoning_retire",
};

/** What a row cannot be made as, nothing made, in the words the hob use cases use. */
const proposalRefused = (proposal: HobProposal, rowId: string | null, message: string) =>
  new HobProposalRefused({ proposalId: proposal.id, ...(rowId === null ? {} : { rowId }), message });

/** A Summoning tool as a hob is offered it. */
const tool = (name: SummoningToolName) => {
  const found = SUMMONING_TOOLS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`The Summoning Charm has no tool ${name}.`);
  return { ...found, inputSchema: summoningToolJsonSchema(name) };
};
