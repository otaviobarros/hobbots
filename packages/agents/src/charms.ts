import {
  type AgentId,
  type AttemptId,
  type CharmDeclaration,
  GIT_INIT_TOOL,
  holdsCharm,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
  type MessageId,
  READ_HOB_TOOL,
  SKILL_TOOL_DESCRIPTIONS,
  TASK_TOOLS,
  type TaskId,
  type ThreadId,
  WEB_FETCH_TOOL,
  type WebPageCache,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import type { AskableVerdict } from "./asking.ts";
import { type CharmCallRunner, makeCharmCallRunner, type ReadBack } from "./charm-calls.ts";
import { CharmDeclarations } from "./grants.ts";
import {
  type HubAction,
  type HubActionEffect,
  type HubActionsOptions,
  type HubRequest,
  makeHubActions,
  readBacksOf,
} from "./hub-actions.ts";
import { MemoryTools } from "./memory.ts";
import type {
  CallSteering,
  HubCallStep,
  HubOffer,
  HubToolAnswer,
  HubTools,
  Takeover,
  ToolAccess,
  TurnApprovals,
} from "./runtime.ts";
import type { Redactor } from "./secrets.ts";
import { SkillTools } from "./skill-proposals.ts";

/** The chat, Task and Attempt a turn's web records name. */
export interface WebRecordPlace {
  readonly threadId: ThreadId | null;
  readonly taskId: Effect.Effect<TaskId | null>;
  readonly attemptId: Effect.Effect<AttemptId | null>;
}

/** A turn that may offer Charm tools: its hob, and how to read the hob's tool access now. */
export interface CharmTurn {
  readonly agentId: AgentId;
  /** The thread and reply the turn writes, so a Charm call's record names the step it showed as. */
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
  /** The Attempt a turn outside any chat runs as, so a call it makes names the session it belongs to (#1049). */
  readonly attemptId?: AttemptId;
  /** The Task a turn outside any chat works on, whose found URLs it reads (ADR 036). */
  readonly taskId?: TaskId;
  /**
   * Where the turn's web records belong (ADR 036, Usage and limits): the chat, and the Task and
   * Attempt it works on once known. A chat turn's Task comes from the thread's work, and a session's
   * chat from its Task. Absent, its records name the fields above.
   */
  readonly webPlace?: WebRecordPlace;
  /** The work the turn's call keys belong to now (#660), from `callScope`, as its Task tools key theirs. */
  readonly scope: () => string;
  /** Another scope a retry of a key is found in: the turn's reply, as for its Task tools. */
  readonly also?: string;
  /** The hob's tool access now, read again for every call so a narrower policy applies to the next (PE-008). */
  readonly currentAccess: Effect.Effect<ToolAccess | null>;
  /** Redacts secrets from what a call returns, before the hob reads it. */
  readonly redactor: Redactor;
  /** Asks the user about calls the policy answers Ask for; null, those calls are refused. */
  readonly approvals: TurnApprovals | null;
}

/** The longest name a hub tool may have (ADR 031). A longer one is refused, never cut. */
export const HUB_TOOL_NAME_MAX = 64;

/** Who offers some hub tools, and their names, for checking that no two offer the same name. */
export interface HubToolOwner {
  /** Who offers them, as an error names it, such as "the GitHub Charm" or "Memory". */
  readonly owner: string;
  readonly names: ReadonlyArray<string>;
}

/**
 * The hub's built-in tool sets beside the Charms (ADR 031), whose names no Charm may take: Local Git,
 * Memory, Skills, the Directory (ADR 032), the Web tools (ADR 036) and the Task tools.
 */
export const BUILT_IN_HUB_TOOLS: ReadonlyArray<HubToolOwner> = [
  { owner: "Local Git", names: [GIT_INIT_TOOL] },
  { owner: "Memory", names: [MEMORY_SEARCH_TOOL, MEMORY_SAVE_TOOL] },
  { owner: "Skills", names: Object.keys(SKILL_TOOL_DESCRIPTIONS) },
  { owner: "the Directory", names: [READ_HOB_TOOL] },
  { owner: "the Web tools", names: [WEB_FETCH_TOOL] },
  { owner: "the Task tools", names: TASK_TOOLS.map((tool) => tool.name) },
];

/**
 * Why a set of hub tool names cannot be served, or null when it can: a name longer than
 * `HUB_TOOL_NAME_MAX`, which is never cut so two long names never become one, or a name two owners
 * offer, naming both.
 */
export const hubToolNameProblem = (owners: ReadonlyArray<HubToolOwner>): string | null => {
  const seen = new Map<string, string>();
  for (const { owner, names } of owners) {
    for (const name of names) {
      if (name.length > HUB_TOOL_NAME_MAX) {
        return `The hub tool name ${name}, from ${owner}, is longer than ${HUB_TOOL_NAME_MAX} characters.`;
      }
      const first = seen.get(name);
      if (first === owner) return `The hub tool ${name} is offered twice by ${owner}.`;
      if (first !== undefined) return `The hub tool ${name} is offered by both ${first} and ${owner}.`;
      seen.set(name, owner);
    }
  }
  return null;
};

/**
 * The hub tools one owner offers a turn, or null when it offers none, and the built-in requests it
 * takes over for the turn: a Charm's, while it is offered (ADR 031).
 */
export interface HubToolSet {
  readonly owner: string;
  readonly tools: HubTools | null;
  readonly takeovers?: ReadonlyArray<Takeover>;
}

/** The built-in requests `sets` take over, in their order. */
export const takeoversOf = (sets: ReadonlyArray<HubToolSet>): ReadonlyArray<Takeover> =>
  sets.flatMap((set) => (set.tools === null ? [] : (set.takeovers ?? [])));

/** The steering of the takeovers `sets` declare, or null when they declare none. */
const steeringOf = (sets: ReadonlyArray<HubToolSet>): CallSteering | null => {
  const takeovers = takeoversOf(sets);
  return takeovers.length === 0 ? null : { takeovers };
};

/**
 * Every tool of several sets, as one, in their order: a call goes to the set that offers its tool.
 * Null when no set offers any. The names were checked when the hub started (`Charms.layer`), so a
 * name two sets offer is a defect, named with both owners, and never goes to either.
 */
export const joinHubTools = (sets: ReadonlyArray<HubToolSet>): HubTools | null => {
  const given = sets.filter((set): set is HubToolSet & { readonly tools: HubTools } => set.tools !== null);
  const problem = hubToolNameProblem(
    given.map((set) => ({ owner: set.owner, names: set.tools.tools.map((tool) => tool.name) })),
  );
  if (problem !== null) throw new Error(problem);
  if (given.length <= 1) return given[0]?.tools ?? null;
  const owner = new Map(given.flatMap((set) => set.tools.tools.map((tool) => [tool.name, set.tools] as const)));
  const all = given.map((set) => set.tools);
  return {
    tools: all.flatMap((set) => set.tools),
    // A tool no set offers goes to the first, which refuses it in its own words.
    call: (name, input, step) => (owner.get(name) ?? (all[0] as HubTools)).call(name, input, step),
  };
};

/**
 * How a Charm steers a built-in request it takes over (ADR 031): a request of `operation`, which its
 * declaration's `takesOver` must name, from a folder where `appliesIn` holds for the turn, is made with
 * the Charm's own `tool` instead.
 */
export interface CharmTakeover {
  readonly operation: Takeover["operation"];
  readonly tool: string;
  readonly appliesIn: (turn: CharmTurn, cwd: string) => Effect.Effect<boolean>;
}

/** What a Charm says of itself, as it defines itself and as the registry holds it. */
interface CharmIdentity {
  /** Its id, its operations and the built-in requests it takes over. */
  readonly declaration: CharmDeclaration;
  /** Its name as the hob and the user read it, such as "GitHub". */
  readonly name: string;
  /** Whether the Charm can act for the hob now, such as while GitHub is connected for it. */
  readonly connected: (agentId: AgentId) => Effect.Effect<boolean>;
  /**
   * How it steers the built-in requests its declaration takes over, for a hob offered its tools.
   * A request it declares no steering for is decided as itself, as Push is from a folder whose origin
   * is not on GitHub.
   */
  readonly takeovers?: ReadonlyArray<CharmTakeover>;
  /** The hub's services each call runs with, its logger included, since a runtime runs it on its own. */
  readonly context?: Context.Context<never>;
  /**
   * Whether a session outside any chat, a party member's or a step's, is offered its writes too. A
   * write whose answer is lost is settled on the reply step it showed as (ADR 020), which such a
   * session lacks, so only a Charm whose writes act on the hub's own records, each read back from
   * them, offers its writes there, as the Summoning Charm does (ADR 034).
   */
  readonly writesOutsideChats?: boolean;
}

/**
 * A Charm as the hub registers it (ADR 031): how it declares itself to the policy, its name, its
 * actions, which the hub action pipeline decides and runs, how its requests are decided, and whether
 * it can act for a hob now. Signing in and storing credentials stay with the Charm.
 */
export interface CharmDefinition<R extends HubRequest, V extends AskableVerdict> extends CharmIdentity {
  /** Its actions, in the order a hob is offered them, each with its read-back when it has one. */
  readonly actions: ReadonlyArray<HubAction<R>>;
  readonly decide: HubActionsOptions<R, V>["decide"];
}

/** A registered Charm, with what the registry needs of it whatever its requests are. */
export interface Charm extends CharmIdentity {
  /** Its tools' names, and which of them write. */
  readonly tools: ReadonlyArray<{ readonly name: string; readonly effect: HubActionEffect }>;
  readonly readBacks: Readonly<Record<string, ReadBack>>;
  /** Its actions for a turn, run through the pipeline with the hub's one never-twice runner. */
  readonly serve: (calls: CharmCallRunner) => (turn: CharmTurn) => HubTools;
}

/** Whether the hob still holds `charm` (ADR 031). */
const holder = (charm: CharmDeclaration) => (access: ToolAccess) => holdsCharm(access.policy.hob, charm.id);

/** A Charm, ready to register with `Charms.layer`. */
export const defineCharm = <R extends HubRequest, V extends AskableVerdict>(
  definition: CharmDefinition<R, V>,
): Charm => {
  const { actions, decide, ...identity } = definition;
  const { declaration, name } = identity;
  return {
    ...identity,
    tools: actions.map((action) => ({ name: action.tool.name, effect: action.effect })),
    readBacks: readBacksOf(actions),
    serve: (calls) =>
      makeHubActions({
        owner: { _tag: "Charm", declaration, name, holds: holder(declaration) },
        actions,
        decide,
        calls,
      }),
  };
};

/** The prefix a built-in Charm's tool names start with: its id, as `<charm>_<action>` (ADR 031). */
const toolPrefix = (charm: CharmDeclaration) => `${charm.id.replaceAll("-", "_")}_`;

/**
 * Why a Charm's steering cannot be registered, or null when it can: a takeover of a request its
 * declaration does not take over, two of the same request, or one steered to a tool it does not offer.
 */
const takeoverProblem = (charm: Charm): string | null => {
  const seen = new Set<string>();
  for (const takeover of charm.takeovers ?? []) {
    if (!(charm.declaration.takesOver as ReadonlyArray<string>).includes(takeover.operation)) {
      return `The ${charm.name} Charm steers ${takeover.operation}, which it does not take over.`;
    }
    if (seen.has(takeover.operation)) return `The ${charm.name} Charm steers ${takeover.operation} twice.`;
    seen.add(takeover.operation);
    if (!charm.tools.some((tool) => tool.name === takeover.tool)) {
      return `The ${charm.name} Charm steers ${takeover.operation} to ${takeover.tool}, which it does not offer.`;
    }
  }
  return null;
};

/** Why the Charms cannot be registered together, or null when they can (ADR 031). */
export const charmsProblem = (charms: ReadonlyArray<Charm>): string | null => {
  const ids = new Set<string>();
  for (const charm of charms) {
    if (ids.has(charm.declaration.id)) return `Two Charms are called ${charm.declaration.id}.`;
    ids.add(charm.declaration.id);
    const misnamed = charm.tools.find((tool) => !tool.name.startsWith(toolPrefix(charm.declaration)));
    if (misnamed !== undefined) {
      return `The ${charm.name} Charm's tool ${misnamed.name} does not start with ${toolPrefix(charm.declaration)}.`;
    }
    const problem = takeoverProblem(charm);
    if (problem !== null) return problem;
    const unread = charm.tools.find((tool) => tool.effect === "write" && !Object.hasOwn(charm.readBacks, tool.name));
    if (charm.writesOutsideChats === true && unread !== undefined) {
      return `The ${charm.name} Charm offers its writes outside chats, but its tool ${unread.name} reads nothing back.`;
    }
  }
  return hubToolNameProblem([
    ...BUILT_IN_HUB_TOOLS,
    ...charms.map((charm) => ({ owner: `the ${charm.name} Charm`, names: charm.tools.map((tool) => tool.name) })),
  ]);
};

/**
 * What a turn is offered of the Charms: with `writes` false, none of their writes, but for a Charm
 * that offers them outside chats.
 */
export interface CharmOffer {
  readonly writes?: boolean;
}

/**
 * The Charm registry (ADR 031): the Charms the hub holds, registered once, in its composition, and
 * served on the hub outside the sandbox, which holds their credentials. A turn is offered the
 * actions of each Charm its hob holds that is connected, each Charm's tools as a list of their own.
 * Absent, a turn offers none.
 */
export class Charms extends Context.Service<
  Charms,
  {
    readonly charms: ReadonlyArray<Charm>;
    /**
     * The tools of each Charm the turn's hob holds and that is connected, read at its start, so a
     * change applies from the next turn, with the steering of the built-in requests each takes over.
     */
    readonly forTurn: (turn: CharmTurn, offer?: CharmOffer) => Effect.Effect<ReadonlyArray<HubToolSet>>;
  }
>()("@hobbots/agents/Charms") {
  /**
   * Registers `charms`, with one never-twice runner for all of them, built from every Charm's
   * read-backs. A tool name two of them share, or a built-in hub tool's, or one longer than
   * `HUB_TOOL_NAME_MAX`, stops the hub with an error that names it. It also provides
   * `CharmDeclarations` from the same Charms, so a Charm registered here is the policy's too: its id
   * can be granted, and its operations can be ruled on, without being declared anywhere else.
   */
  static readonly layer = <R>(charms: ReadonlyArray<Effect.Effect<Charm, never, R>>) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const registered = yield* Effect.all(charms);
        const problem = charmsProblem(registered);
        if (problem !== null) return yield* Effect.die(new Error(problem));
        const runner = yield* makeCharmCallRunner(
          Object.assign({}, ...registered.map((charm) => charm.readBacks)) as Record<string, ReadBack>,
        );
        const served = registered.map((charm) => ({ charm, serve: charm.serve(runner) }));
        const within =
          (charm: Charm) =>
          <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
            charm.context === undefined ? effect : Effect.provideContext(effect, charm.context);

        const setFor = (charm: Charm, serve: (turn: CharmTurn) => HubTools, turn: CharmTurn, offer?: CharmOffer) => {
          const run = within(charm);
          const hub = serve(turn);
          const writes = new Set(charm.tools.filter((tool) => tool.effect === "write").map((tool) => tool.name));
          const tools =
            offer?.writes === false && charm.writesOutsideChats !== true
              ? hub.tools.filter((tool) => !writes.has(tool.name))
              : hub.tools;
          // A Charm steers the requests it takes over while it offers the turn any tool.
          const takeovers = (charm.takeovers ?? []).map(
            (takeover): Takeover => ({
              operation: takeover.operation,
              charm: charm.name,
              tool: takeover.tool,
              appliesIn: (cwd) => run(takeover.appliesIn(turn, cwd)),
            }),
          );
          return {
            owner: `the ${charm.name} Charm`,
            tools:
              tools.length === 0
                ? null
                : {
                    tools,
                    call: (name: string, input: unknown, step?: HubCallStep) => run(hub.call(name, input, step)),
                  },
            takeovers,
          };
        };

        const service = Charms.of({
          charms: registered,
          forTurn: (turn, offer) =>
            Effect.gen(function* () {
              const access = yield* turn.currentAccess;
              if (access === null) return [];
              const sets: Array<HubToolSet> = [];
              for (const { charm, serve } of served) {
                if (!holdsCharm(access.policy.hob, charm.declaration.id)) continue;
                if (!(yield* within(charm)(charm.connected(turn.agentId)))) continue;
                sets.push(setFor(charm, serve, turn, offer));
              }
              return sets;
            }),
        });
        return Context.make(Charms, service).pipe(
          Context.add(
            CharmDeclarations,
            registered.map((charm) => charm.declaration),
          ),
        );
      }),
    );
}

/**
 * The local Git work a turn's hob asks the hub to do outside its turn's sandbox (ADR 014), such as creating
 * a repository, whose config and hooks the sandbox keeps read-only. The hub decides every call under
 * the hob's policy. Absent, a turn offers none.
 */
export class LocalGitTools extends Context.Service<
  LocalGitTools,
  {
    /** The tools the turn offers, read at its start: none (null) for a turn without folders. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/LocalGitTools") {}

/**
 * The Directory set (ADR 032): `read_hob`, which reads one other hob's public card on the hub. The hub
 * decides every call under the hob's Read other hobs answer. Absent, a turn offers none.
 */
export class DirectoryTools extends Context.Service<
  DirectoryTools,
  {
    /** The tools the turn offers, read at its start: none (null) when its answer is Never. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/DirectoryTools") {}

/**
 * The Web set (ADR 036): `web_fetch`, which reads one public page on the hub, decided as Use the web
 * for the page's host. Absent, a turn offers none.
 */
export class WebTools extends Context.Service<
  WebTools,
  {
    /** The tools the turn offers, read at its start: none (null) when its Use the web answer is Never. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
    /** The pages the hub holds for a while (ADR 036), which Settings › Web counts and clears. */
    readonly cache?: {
      readonly held: Effect.Effect<WebPageCache>;
      readonly clear: Effect.Effect<void>;
    };
  }
>()("@hobbots/agents/WebTools") {}

/**
 * A hub tool call's answer as the hob reads it: a refusal, with its reason, as a refused answer, and
 * every answer redacted, as everything a hob reads is.
 */
export const hubAnswer = <R>(
  redactor: Redactor,
  call: Effect.Effect<HubToolAnswer, { readonly _tag: "Refused"; readonly message: string }, R>,
): Effect.Effect<HubToolAnswer, never, R> =>
  call.pipe(
    Effect.catchTag("Refused", (refused) => Effect.succeed<HubToolAnswer>({ text: refused.message, refused: true })),
    Effect.map((answer) => ({ ...answer, text: redactor.text(answer.text) })),
  );

/**
 * The local Git, Charm, memory, skill, directory and web tools a turn offers, read at its start under the access the turn
 * reads (ADR 014): a chat turn's, a party member's or a step's, each narrowed by its Delegations.
 * Every kind of turn that offers Task tools offers them this one way, so the tools a delegation
 * promises are the tools its member gets (#699), and every runtime that serves hub tools serves
 * memory (ADR 028), skills (ADR 029), the directory (ADR 032) and `web_fetch` (ADR 036). Without a service, a turn offers none of its tools. The
 * offer's steering holds the built-in requests its Charms take over (ADR 031).
 */
export const hubToolOffer = Effect.gen(function* () {
  const localGit = yield* Effect.serviceOption(LocalGitTools);
  const charms = yield* Effect.serviceOption(Charms);
  const memory = yield* Effect.serviceOption(MemoryTools);
  const skills = yield* Effect.serviceOption(SkillTools);
  const directory = yield* Effect.serviceOption(DirectoryTools);
  const web = yield* Effect.serviceOption(WebTools);
  const none = Effect.succeed(null);
  // Each reads the turn's access itself, so they are read side by side.
  return (turn: CharmTurn, offer?: CharmOffer): Effect.Effect<HubOffer> =>
    Effect.all(
      [
        Option.isSome(localGit) ? localGit.value.forTurn(turn) : none,
        Option.isSome(charms) ? charms.value.forTurn(turn, offer) : Effect.succeed([]),
        Option.isSome(memory) ? memory.value.forTurn(turn) : none,
        Option.isSome(skills) ? skills.value.forTurn(turn) : none,
        Option.isSome(directory) ? directory.value.forTurn(turn) : none,
        Option.isSome(web) ? web.value.forTurn(turn) : none,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([git, charmSets, memoryTools, skillTools, directoryTools, webTools]) => {
        const sets = [
          { owner: "Local Git", tools: git },
          ...charmSets,
          { owner: "Memory", tools: memoryTools },
          { owner: "Skills", tools: skillTools },
          { owner: "the Directory", tools: directoryTools },
          { owner: "the Web tools", tools: webTools },
        ];
        return { hubTools: joinHubTools(sets), steering: steeringOf(sets) };
      }),
    );
});

/**
 * A program that runs inside a hob's sandbox: a shell command line, and the variables its process
 * needs on top of the caller's own. Arguments a caller appends to the line are not passed on.
 */
export interface SandboxedProgram {
  readonly commandLine: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Why a program cannot run in the sandbox, in words for the hob and the person. */
export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()("SandboxUnavailable", {
  message: Schema.String,
}) {}

/**
 * Runs a Charm's reads of a hob's folders in the same OS sandbox as the hob's turns (ADR 020): able
 * to read only those folders, write nothing of the hob's and reach no network. Whatever a folder's
 * files point at, the program reads nothing outside them. The sandbox lasts as long as the scope.
 */
export class FolderSandbox extends Context.Service<
  FolderSandbox,
  {
    readonly readOnly: (
      folders: ReadonlyArray<string>,
      program: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<SandboxedProgram, SandboxUnavailable, Scope.Scope>;
  }
>()("@hobbots/agents/FolderSandbox") {}
