import type { CreateAgentPayload, UpdateAgentPayload, UpdateHobPermissionsPayload } from "@hobbots/api";
import {
  type Agent,
  AgentId,
  type AnyOperation,
  type ChangeActor,
  type CharmCall,
  type CharmId,
  type CharmOperation,
  type CharmOperationId,
  type CharmOverrides,
  DEFAULT_SIGIL,
  DRAFT_FIELDS,
  fieldsSet,
  HobColor,
  type HobPolicy,
  heldCharms,
  hobProfilePath,
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
  SUMMONING_CHARM,
  SUMMONING_CHARM_ID,
  SUMMONING_CHECK_TOOL,
  SUMMONING_FIELD_WORDS,
  SUMMONING_TOOLS,
  type SummoningChange,
  type SummoningDraft,
  type SummoningField,
  SummoningInputs,
  type SummoningToolName,
  selfFieldOperation,
  starterRole,
  summoningFieldOperation,
  summoningScopeOf,
  summoningToolJsonSchema,
  type TaskId,
  withSummoningForEveryHob,
} from "@hobbots/domain";
import { Context, Deferred, Effect, Layer, Option } from "effect";
import type { AskableVerdict } from "./asking.ts";
import { type Charm, defineCharm } from "./charms.ts";
import { checkGoodAt, checkRole, checkRuntimeBrain, HobService } from "./hobs.ts";
import { type HubAction, type HubPlanContext, HubRefusal, hubAction } from "./hub-actions.ts";
import { HobLifecycle } from "./lifecycle.ts";
import { FolderChecks, HobGitHubApps, InstallationSettings } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import {
  type RuntimeAdapters,
  runtimeAdapters,
  type ToolAccess,
  type ToolPolicy,
  type TurnApprovals,
} from "./runtime.ts";
import { operationDecision } from "./tools.ts";

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
}

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
  }
>()("@hobbots/agents/SummoningHub") {
  static readonly layer = Layer.effect(
    SummoningHub,
    Effect.gen(function* () {
      const bound = yield* Deferred.make<SummoningServices>();
      return SummoningHub.of({
        services: Deferred.await(bound),
        bind: (services) => Deferred.succeed(bound, services).pipe(Effect.asVoid),
      });
    }),
  );

  /** Binds the hub's hob use cases to the Charm, where they are built. */
  static readonly bound = Layer.effectDiscard(
    Effect.gen(function* () {
      const hub = yield* SummoningHub;
      yield* hub.bind({
        hobs: yield* HobService,
        lifecycle: yield* HobLifecycle,
        repo: yield* HobbotsRepository,
        adapters: yield* runtimeAdapters,
        folders: yield* FolderChecks,
        setup: yield* InstallationSettings,
        apps: yield* Effect.serviceOption(HobGitHubApps),
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

    /** Problems with the folders, Charms and answers a draft or change gives, against the manager (ADR 034). */
    const authorityProblems = (
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
        for (const charm of draft.charms ?? []) {
          if (charm === SUMMONING_CHARM_ID) problems.push("Only the user grants the Summoning Charm.");
          else if (!manager.charms.includes(charm)) {
            problems.push(`authority-wider: charms, since you do not hold the ${charm} Charm.`);
          }
        }
        for (const [operation, answer] of Object.entries(draft.answers ?? {})) {
          if (answer === undefined) continue;
          if (operation.startsWith(`${SUMMONING_CHARM_ID}.`)) {
            problems.push("Only the user sets the Summoning Charm's answers.");
          } else if (!isNarrowerOrEqual(answer, manager.answer(operation as AnyOperation))) {
            problems.push(`authority-wider: answers, since ${operation} would be wider than your own.`);
          }
        }
        return problems;
      });

    /** Problems with a draft's name, role, good at and brain, as Summon and the profile refuse them. */
    const fieldProblems = (
      draft: SummoningDraft,
      fallback: Pick<Agent, "runtime" | "model" | "effort">,
      services: SummoningServices,
    ) =>
      Effect.gen(function* () {
        const problems: Array<string> = [];
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
        if (draft.name === undefined || draft.name.trim() === "") problems.push("It needs a name.");
        if (draft.role == null && (draft.role_title === undefined || draft.role_title.trim() === "")) {
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
        ...(draft.good_at === undefined ? {} : { goodAt: draft.good_at }),
        ...(draft.voice === undefined ? {} : { voice: draft.voice }),
        ...(draft.length === undefined ? {} : { length: draft.length }),
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
        name: change.name,
        role: change.role,
        roleTitle: change.role_title,
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
      return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      ) as UpdateAgentPayload;
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
      return {
        ...(change.own_folders === undefined ? {} : { ownFolders: change.own_folders }),
        ...(change.hidden_shared_folders === undefined ? {} : { hiddenSharedFolders: change.hidden_shared_folders }),
        ...(builtIn === undefined ? {} : { overrides: builtIn as PolicyOverrides }),
        ...(charms === undefined ? {} : { charms }),
      };
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
          const text =
            rows.length === 0
              ? "Give drafts of new hobs under summon, or of changes under change, to check them."
              : `Checked; nothing was changed.\n${rows.join("\n")}`;
          return { _tag: "NoCall", text } as const;
        }),
    });

    const summon = hubAction({
      tool: tool("summoning_summon"),
      input: SummoningInputs.summoning_summon,
      effect: "write",
      otherwise: "no hob was summoned",
      readBack: (call: CharmCall) =>
        Effect.gen(function* () {
          const services = yield* hub.services;
          const { ids } = JSON.parse(call.plan) as { readonly ids: ReadonlyArray<AgentId> };
          for (const id of ids) if (Option.isNone(yield* services.repo.findAgent(id))) return false;
          return true;
        }),
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
          const unattended = manager.answer(SUMMON_OPERATION) === "allow";
          const actor = actorOf(context);
          const names = input.hobs.map((draft) => (draft.name ?? "").trim());
          const hiddenShared = shared.filter((folder) => !manager.shared.includes(folder));
          const send = Effect.gen(function* () {
            const created: Array<Agent> = [];
            const failed: Array<string> = [];
            for (const [index, draft] of input.hobs.entries()) {
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
              const payload = createPayload(draft, ids[index] as AgentId, manager.agent, seed);
              const hob = yield* services.hobs
                .create(payload, { actor, taskId: taskOf(context), unattended, policy })
                .pipe(Effect.result);
              if (hob._tag === "Success") created.push(hob.success);
              else failed.push(`- ${payload.name}: ${failure(hob.failure)}`);
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
          return {
            request: request(SUMMON_OPERATION, [part(SUMMON_OPERATION, names)]),
            card: card(input, `Summon ${names.join(", ")}`),
            write: {
              site: `summon:${context.turn.agentId}`,
              recorded: { ids, names },
              appliedText: `Summoned ${names.join(", ")}.`,
              send,
            },
          };
        }),
    });

    const change = hubAction({
      tool: tool("summoning_change"),
      input: SummoningInputs.summoning_change,
      effect: "write",
      otherwise: "no hob was changed",
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
              const profile = updatePayload(each);
              const permissions = permissionsPayload(each, row.agent.policy);
              const applied = yield* Effect.gen(function* () {
                if (Object.keys(profile).length > 0) yield* services.hobs.update(row.agent.id, profile, actor);
                if (permissions !== null) yield* services.hobs.updatePolicy(row.agent.id, permissions, actor);
              }).pipe(Effect.result);
              if (applied._tag === "Success") done.push(`- ${row.agent.name}: changed ${fieldsSet(each).join(", ")}.`);
              else failed.push(`- ${row.agent.name}: ${failure(applied.failure)}`);
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
          return {
            request: request(parts[0]?.operation ?? summoningFieldOperation("name"), parts, safety),
            card: card(input, `Change ${rows.map((row) => row.agent.name).join(", ")}`),
            write: {
              site: `change:${[...ids].sort().join(",")}`,
              recorded: { ids },
              appliedText: `Changed ${rows.map((row) => row.agent.name).join(", ")}.`,
              send,
            },
          };
        }),
    });

    /** Pause, wake or retire one hob within the scope, never the manager itself. */
    const lifecycleAction = (
      name: "summoning_pause" | "summoning_wake" | "summoning_retire",
      verb: string,
      run: (
        services: SummoningServices,
        agent: Agent,
        input: { readonly hob: string; readonly running_replies?: "finish" | "stop" },
        actor: ChangeActor,
      ) => Effect.Effect<Agent, { readonly message: string }>,
      status: Agent["status"],
    ) =>
      hubAction({
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
        plan: (input, context) =>
          Effect.gen(function* () {
            const { services, agents, manager } = yield* prepare(context);
            const found = target(agents, { id: manager.agent.id, policy: manager.policy }, input.hob);
            if (typeof found === "string") {
              const code =
                found.startsWith("There is no") || found.startsWith("Several") ? "unknown-hob" : "outside-scope";
              return yield* refused(code, found);
            }
            if (found.self) return yield* refused("outside-scope", `You never ${verb.replace(/d$/, "")} yourself.`);
            const operation = name === "summoning_retire" ? RETIRE_OPERATION : PAUSE_OPERATION;
            if (manager.answer(operation) === "deny") {
              return yield* refused("never", `${wordsOf(operation)} is at Never for you.`);
            }
            const policy = yield* effectivePolicy(found.agent, services);
            const authority = yield* authorityOf(found.agent.id, policy, context.access.policy, services);
            const wider = widerFields(authority, manager, operationsOf(context));
            const safety =
              wider.length === 0
                ? null
                : `${found.agent.name} can do more than you (${wider.join(", ")}), so this asks the user.`;
            const actor = actorOf(context);
            const agent = found.agent;
            return {
              request: request(operation, [part(operation, [agent.name])], safety),
              card: card(input, `${verb.charAt(0).toUpperCase()}${verb.slice(1, -1)} ${agent.name}`),
              write: {
                site: `hob:${agent.id}`,
                recorded: { id: agent.id, status },
                appliedText: `${agent.name} is ${status} now.`,
                send: run(services, agent, input, actor).pipe(
                  Effect.map((after) => ({ _tag: "Applied", text: `${after.name} is ${after.status} now.` }) as const),
                  Effect.catch((error) => Effect.succeed({ _tag: "Refused", text: failure(error) } as const)),
                ),
              },
            };
          }),
      });

    const actions: ReadonlyArray<HubAction<SummoningRequest>> = [
      check,
      summon,
      change,
      lifecycleAction(
        "summoning_pause",
        "paused",
        (s, agent, _input, actor) => s.lifecycle.pause(agent.id, actor),
        "paused",
      ),
      lifecycleAction(
        "summoning_wake",
        "woken",
        (s, agent, _input, actor) => s.lifecycle.wake(agent.id, actor),
        "active",
      ),
      lifecycleAction(
        "summoning_retire",
        "retired",
        (s, agent, input, actor) => s.lifecycle.retire(agent.id, input.running_replies ?? "finish", actor),
        "retired",
      ),
    ];

    return defineCharm({
      declaration: SUMMONING_CHARM,
      name: "Summoning",
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

/** A Summoning tool as a hob is offered it. */
const tool = (name: SummoningToolName) => {
  const found = SUMMONING_TOOLS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`The Summoning Charm has no tool ${name}.`);
  return { ...found, inputSchema: summoningToolJsonSchema(name) };
};
