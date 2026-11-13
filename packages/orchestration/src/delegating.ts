import {
  type DroppedTool,
  type FolderChecksShape,
  type HobbotsRepository,
  type OfferedTool,
  RUNTIME_TOOLS_OWNER,
  type SessionToolOffer,
  type TaskRepository,
} from "@hobbots/agents";
import {
  type Agent,
  AgentId,
  ArtifactId,
  ancestorsOf,
  CriterionId,
  type DelegationAuthority,
  DelegationId,
  hobStanding,
  isCancellingTask,
  isTerminalTask,
  MilestoneId,
  NoteId,
  openTools,
  type PolicyDecision,
  type PolicyOperation,
  type PolicyOverrides,
  type Quest,
  QuestId,
  type QuestLimits,
  questsAbove,
  type Task,
  TaskId,
  type TaskToolInput,
  type TaskToolRefused,
  type TaskTree,
  takesNewWork,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { type Authority, delegatedAuthority, narrowBy, operationsOf, type PathSeparator } from "./authority.ts";
import { cut, firstLine, planNote } from "./briefs.ts";
import {
  type CallScope,
  depthWithin,
  fromRecords,
  journalOf,
  leads,
  ledTask,
  newId,
  ownTask,
  questLimitsFor,
  refuse,
  type TaskToolLimits,
} from "./call-scope.ts";
import { briefTargets, defaultFolders, namedFolders, outOfReach, withFolders } from "./default-folders.ts";

interface Deps {
  readonly tasks: TaskRepository["Service"];
  readonly hobs: HobbotsRepository["Service"];
  readonly folderChecks: FolderChecksShape;
  readonly capacity: (scope: CallScope, ownerId: AgentId, adding: number) => Effect.Effect<void, TaskToolRefused>;
  readonly authority: {
    /** The caller's authority on a Task: its own, narrowed by every Delegation on the way down. */
    readonly of: (scope: CallScope, task: Task) => Effect.Effect<Authority>;
    /** What a hob's own policy lets it do now. */
    readonly own: (agentId: AgentId) => Effect.Effect<Authority>;
  };
  readonly limits: TaskToolLimits;
  readonly separator: PathSeparator;
  /**
   * What a member's session will be offered under the authority each Delegation on the way down to
   * its Task gives it, top first: read from the offer its session is built from (#1348).
   */
  readonly memberOffer: (member: Agent, given: ReadonlyArray<DelegationAuthority>) => Effect.Effect<SessionToolOffer>;
}

type DelegateInput = Omit<TaskToolInput<"delegate_task">, "key">;

/** How many of the work's artifacts a refused `hand_off` names. */
const LISTED_ARTIFACTS = 5;

/**
 * Why `hand_off` refused an id, and what to pass instead (#1088): it takes the id of an artifact a Task
 * returned with complete_task, never a Task's id, and a Task that returned none has nothing to hand
 * off, since its result already reaches the Tasks that depend on it. It names only the Tasks the
 * caller leads and their artifacts, the ones hand_off accepts, so a member never learns of a sibling
 * branch's work (STD-SEC-003).
 */
const missingArtifact = (scope: CallScope, id: string): string => {
  const led = scope.tree.tasks.filter((task) => leads(scope, task));
  const ledIds = new Set<string>(led.map((task) => task.id));
  const asTask = ledIds.has(id)
    ? ` ${id} is a Task's id: hand_off takes the id of an artifact a Task returned with complete_task.`
    : "";
  const artifacts = scope.tree.artifacts.filter((artifact) => ledIds.has(artifact.taskId));
  if (artifacts.length === 0) {
    return `No artifact ${id} in the work you lead.${asTask} No Task under yours has returned an artifact yet, so there is nothing to hand off. A Task's result already reaches the Tasks that depend on it; to tell a running Task something, use message_task.`;
  }
  const listed = artifacts
    .slice(-LISTED_ARTIFACTS)
    .map((each) => `${each.label} (artifact_id ${each.id}, from Task ${each.taskId})`);
  const more = artifacts.length > LISTED_ARTIFACTS ? " read_tasks lists the rest." : "";
  return `No artifact ${id} in the work you lead.${asTask} The artifacts you can hand off: ${listed.join("; ")}.${more}`;
};

/** Longest text of yours a delegated Task carries on as its lead's note. */
const NOTE_LIMIT = 2_000;

/** A hob that can take work, by its id or its name. */
export const findHob = (hobs: Deps["hobs"], named: string): Effect.Effect<Agent, TaskToolRefused> =>
  Effect.gen(function* () {
    const byId = yield* hobs.findAgent(AgentId.make(named));
    const wanted = named.trim().toLowerCase();
    const hob = Option.isSome(byId)
      ? byId.value
      : (yield* hobs.listAgents).find((agent) => agent.name.trim().toLowerCase() === wanted);
    if (hob === undefined) return yield* refuse("hob-missing", `There is no hob named ${named}.`);
    if (!takesNewWork(hob))
      return yield* refuse("hob-missing", `${hob.name} is ${hobStanding(hob)} and cannot take work.`);
    return hob;
  });

/** Checks the member can take this Task: not the caller itself, and not a hob that already leads its lineage. */
export const checkMember = (scope: CallScope, task: Task, member: Agent) => {
  if (member.id === scope.caller.agentId) {
    return refuse("own-hob", "You cannot delegate to yourself. Split your own work with plan_steps.");
  }
  const lineage = [task, ...ancestorsOf(task, scope.tree.tasks)];
  if (lineage.some((each) => each.ownerId === member.id)) {
    return refuse("cycle", `${member.name} already owns work this Task is part of, so it cannot be given part of it.`);
  }
  const passed = questsAbove(task, scope.tree.tasks, scope.tree.quests).find(
    (quest) => quest.limits.deadline !== null && Date.parse(quest.limits.deadline) <= Date.parse(scope.at),
  );
  if (passed !== undefined)
    return refuse("deadline-passed", `The Quest's deadline ${passed.limits.deadline} has passed.`);
  return Effect.void;
};

/** How long the member has: at most what the caller was given for its own Task. */
const timeoutFor = (scope: CallScope, task: Task, minutes: number | undefined) => {
  const path = [task, ...ancestorsOf(task, scope.tree.tasks)].map((each) => each.id as string);
  const given = scope.tree.delegations
    .filter((delegation) => path.includes(delegation.childTaskId) && delegation.timeoutMs !== null)
    .map((delegation) => delegation.timeoutMs as number);
  const most = given.length === 0 ? null : Math.min(...given);
  const asked = minutes === undefined ? null : minutes * 60_000;
  if (asked !== null && most !== null && asked > most) {
    return refuse("authority-wider", `The member can have at most ${Math.floor(most / 60_000)} minutes.`);
  }
  return Effect.succeed(asked ?? most);
};

const COMMAND_OPERATIONS: ReadonlyArray<PolicyOperation> = ["run-commands", "local-git"];

/** The file answers that close commands (ADR 014): Read files other than Allow, or Edit files Ask. */
const closesCommands = (operation: PolicyOperation, decision: PolicyDecision): boolean =>
  operation === "read-files" ? decision !== "allow" : operation === "edit-files" && decision === "ask";

/** What the lead is told of a member whose commands are read-only (#1344). */
const readOnlyNote = (name: string) =>
  ` ${name}'s commands are read-only: its folders, .git included, are closed to every write, so it can run git status, git diff, git log or a test that writes only to $TMPDIR, but cannot commit or change a file.`;

/**
 * What the member's tools will be under `decisions`, in words for the lead, refusing a request whose
 * own answers open commands and close the file operations they run with, so no member is given work
 * it has no tool for (#661). Commands need Read files Allow and Edit files Allow or Never, read-only
 * under Never (#1344). The same gap left by the lead's or the member's own policy is a warning.
 * With no folder, or reading denied, the member's turns are chat-only, as `toolTurn` makes them.
 * Commands also need the member's sandbox, which is decided when its turn starts.
 */
const toolsFor = (
  member: Agent,
  asked: PolicyOverrides | undefined,
  { decisions, folders }: Pick<Authority, "decisions" | "folders">,
  offer: SessionToolOffer,
) => {
  const open = openTools((operation) => decisions[operation]);
  // Commands also need the runtime's sandbox, as the offer the session is built from says.
  const sandbox = !offer.dropped.some((tool) => tool.reason === "no-sandbox");
  const chatOnly =
    folders.length === 0 ? "no folder is both yours and its own" : open.read ? null : "it would have read-files deny";
  const tools = [
    [open.read, "file reads"],
    [open.edit, "file edits"],
    [open.commands && sandbox, open.commandsReadOnly ? "read-only commands" : "commands"],
    [open.gitInit, "git_init"],
  ] as const;
  const has = tools.flatMap(([on, name]) => (on ? [name] : []));
  const lacks = tools.flatMap(([on, name]) =>
    on
      ? []
      : [
          open.commands && !sandbox && name.endsWith("commands")
            ? `no ${name} (its runtime has no sandbox here)`
            : `no ${name}`,
        ],
  );
  const summary =
    chatOnly === null
      ? ` ${member.name} will have: ${[has.join(", "), ...(lacks.length === 0 ? [] : [lacks.join(", ")])].join("; ")}.${open.commandsReadOnly && sandbox ? readOnlyNote(member.name) : ""}`
      : ` ${member.name} will have no tools: ${chatOnly}, so its turns are chat-only. Do the Task's file work yourself, or give it work that needs no files.`;
  const commands = COMMAND_OPERATIONS.filter((operation) => decisions[operation] !== "deny");
  if (open.commands || commands.length === 0) return Effect.succeed(summary);
  const closing = (["read-files", "edit-files"] as const).filter((operation) =>
    closesCommands(operation, decisions[operation]),
  );
  const rule = `commands, Git's included, need read-files allow and edit-files allow, or edit-files deny for read-only commands, and ${member.name} would have ${closing.map((operation) => `${operation} ${decisions[operation]}`).join(" and ")}`;
  // Refused only when the request's own answers make the gap; one the lead or member already has warns.
  const gives = commands.filter((operation) => asked?.[operation] !== undefined);
  const takes = closing.filter((operation) => (asked?.[operation] ?? "allow") !== "allow");
  if (gives.length > 0 && takes.length > 0) {
    const readOnly = takes.includes("edit-files") ? " (or edit-files deny, for read-only commands)" : "";
    return refuse(
      "authority-unusable",
      `${member.name} could not use ${gives.join(" or ")}: ${rule}. Give ${takes.join(" and ")} allow${readOnly}, or give ${gives.join(" and ")} deny and run the commands yourself.${summary}`,
    );
  }
  if (chatOnly !== null) return Effect.succeed(summary);
  return Effect.succeed(
    `${summary} It cannot use ${commands.join(" or ")} though it has them: ${rule}. Run any commands the Task needs yourself.`,
  );
};

const NO_OFFER: SessionToolOffer = { tools: [], dropped: [] };

/**
 * What the records refuse of a new Task under `task`, checked before anything is written so that
 * `check: true` is refused as the call would be: under a Task that ended or is cancelling, or
 * depending on a Task that is not one of its siblings.
 */
const placeable = (scope: CallScope, task: Task, dependsOn: ReadonlyArray<string>) => {
  if (isTerminalTask(task.state)) return refuse("parent-ended", `Task ${task.id} is ${task.state}`);
  if (isCancellingTask(task.state)) return refuse("parent-cancelling", `Task ${task.id} is cancelling`);
  const siblings = new Set<string>(scope.tree.tasks.filter((each) => each.parentId === task.id).map((each) => each.id));
  return dependsOn.every((id) => siblings.has(id))
    ? Effect.void
    : refuse("dependency-outside-tree", "A Task depends only on its siblings");
};

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

const ANSWER_WORDS = { allow: "Allow", ask: "Ask", never: "Never: each call is refused" } as const;

/** Why a tool is not offered, in words for the lead. */
const dropWords = (member: Agent, dropped: DroppedTool): string => {
  switch (dropped.reason) {
    case "never":
      return "its answer is Never";
    case "not-granted":
      return `${member.name} does not hold ${dropped.from}`;
    case "not-connected":
      return `${dropped.from} is not connected`;
    case "chats-only":
      return `${dropped.from} offers its writes only in chats, not in a Task`;
    case "chat-only":
      return "its turns are chat-only";
    case "commands-closed":
      return "commands need Read files Allow and Edit files Allow or Never";
    case "no-sandbox":
      return `${member.name}'s runtime cannot start its sandbox on this hub`;
  }
};

/** Whether the lead hears of a tool by name: the runtime's are in the sentence before, and the Task tools are always offered. */
const named = (tool: { readonly from: string }) => tool.from !== RUNTIME_TOOLS_OWNER && tool.from !== "the Task tools";

/** Whether a tool comes from a Charm, whose tools the lead hears of by name. */
const fromCharm = (tool: { readonly from: string }) => tool.from.endsWith(" Charm");

/**
 * The member's Charm tools in words for the lead (#1348), kept short since the lead reads them in
 * its turn and they are what a brief most often needs: each with its answer, then each named tool
 * it will not be offered and why. The call's details list every tool, a Charm it does not hold or
 * that is not connected included; the warning names one the brief needs.
 */
const offerWords = (member: Agent, offer: SessionToolOffer): string => {
  const byAnswer = (["allow", "ask", "never", null] as const).flatMap((answer) => {
    const tools = offer.tools.filter((tool) => fromCharm(tool) && tool.answer === answer).map((tool) => tool.tool);
    const words = answer === null ? "decided on each call" : ANSWER_WORDS[answer];
    return tools.length === 0 ? [] : [`${listFormat.format(tools)} (${words})`];
  });
  const lacks = offer.dropped
    .filter((tool) => named(tool) && tool.reason !== "not-granted" && tool.reason !== "not-connected")
    .map((tool) => `${tool.tool}, since ${dropWords(member, tool)}`);
  return [
    byAnswer.length === 0 ? "" : ` Its Charm tools: ${byAnswer.join("; ")}.`,
    lacks.length === 0 ? "" : ` It will not be offered ${lacks.join("; ")}.`,
  ].join("");
};

/**
 * Words in a brief that name work needing a tool, by the tool (#1348). Simple on purpose: a brief
 * that names the work is warned about, and one that does not is not.
 */
const NEEDS: ReadonlyArray<{
  /** The tool the work needs, by any of the names the offer gives it. */
  readonly tool: ReadonlyArray<string>;
  readonly words: RegExp;
  readonly work: string;
  /** A tool that does the same work when offered, as a command pushes where no Charm takes it over. */
  readonly or?: string;
}> = [
  { tool: ["github_comment"], words: /\bcomment/i, work: "commenting" },
  { tool: ["github_open_pull_request"], words: /\bpull requests?\b|\bPRs?\b/, work: "opening a pull request" },
  { tool: ["github_push"], words: /\bpush/i, work: "pushing", or: "commands" },
  { tool: ["commands", "read_only_commands"], words: /\bcommit|\brun\b|\btests?\b/i, work: "running commands" },
  { tool: ["file_edits"], words: /\bedit|\bfix\b|\bwrite\b/i, work: "editing files" },
];

/** A warning for the lead when the brief names work that needs a tool the member will not be offered. Empty otherwise. */
const briefNeeds = (member: Agent, brief: string, offer: SessionToolOffer): string => {
  const lacking = NEEDS.flatMap((need) => {
    const tool = offer.dropped.find((each) => need.tool.includes(each.tool));
    const instead = offer.tools.some((each) => each.tool === need.or);
    return tool !== undefined && !instead && need.words.test(brief) ? [{ need, tool }] : [];
  });
  if (lacking.length === 0) return "";
  const each = lacking.map(
    ({ need, tool }) => `${need.work}, but ${tool.tool} will not be offered: ${dropWords(member, tool)}`,
  );
  return ` Warning: the brief names ${each.join("; ")}. Do that part yourself, give ${member.name} what it lacks, or bring in a hob that has it.`;
};

/** The offer as the call's details carry it, for a lead that reads them. */
const offerDetails = (offer: SessionToolOffer) => ({
  // Each tool by its name, with its answer, "per-call" for one decided on each call: compact, since a lead reads it in its turn.
  tools: Object.fromEntries(offer.tools.map((tool: OfferedTool) => [tool.tool, tool.answer ?? "per-call"])),
  dropped: Object.fromEntries(offer.dropped.map((tool) => [tool.tool, tool.reason])),
});

/** Tools a lead brings in other hobs and moves results between them with. */
/** Why delegate_task links no criteria it names (#1445): its Quest has none of those ids. */
const notCriteria = (quest: Quest | undefined, unknown: ReadonlyArray<string>) => {
  const listed = quest?.criteria.map((each) => `${each.id} "${each.text}"`) ?? [];
  return `The Quest has no criterion ${unknown.join(", ")}. ${
    listed.length === 0
      ? "It has no acceptance criteria yet: start_quest gives them, before you delegate."
      : `Its criteria: ${listed.join("; ")}.`
  }`;
};

export const makeDelegating = ({
  tasks,
  hobs,
  folderChecks,
  capacity,
  authority,
  limits,
  separator,
  memberOffer,
}: Deps) => {
  /**
   * The member's authority: the caller's on this Task, narrowed by what the brief asks for and by
   * the member's own policy, so it holds the intersection of the lead's and its own (STD-SEC-003).
   */
  const memberAuthority = (scope: CallScope, task: Task, member: Agent, input: DelegateInput) =>
    Effect.gen(function* () {
      const requested = input.authority;
      const lead = yield* authority.of(scope, task);
      // Left out, the member gets the narrowest folders the work needs; "all" gives all of the lead's (#582).
      const folders =
        requested?.folders === "all"
          ? undefined
          : requested?.folders === undefined
            ? yield* defaultFolders(folderChecks, lead.folders, input.brief, separator)
            : yield* Effect.forEach(requested.folders, (folder) =>
                folderChecks
                  .check(folder)
                  .pipe(Effect.catch(() => refuse("invalid-input", `${folder} is not a folder on this hub.`))),
              );
      const narrowed = delegatedAuthority(
        lead,
        {
          ...(requested?.decisions === undefined ? {} : { decisions: requested.decisions }),
          ...(folders === undefined ? {} : { folders }),
        },
        separator,
      );
      if (narrowed._tag === "Wider") return yield* refuse("authority-wider", narrowed.message);
      const own = yield* authority.own(member.id);
      const both = narrowBy(own, narrowed.authority, separator);
      // Only the answers the Delegation gives: the member's own preset answers stay its own.
      const overrides = Object.fromEntries(
        operationsOf(both).flatMap((operation) =>
          narrowed.authority.overrides[operation] === undefined
            ? []
            : [[operation, both.decisions[operation] ?? "deny"]],
        ),
      );
      // Where the brief asks for work the member cannot reach, its lead hears so now (#1181).
      const { folders: named, parents } = yield* briefTargets(folderChecks, lead.folders, input.brief, separator);
      const unreachable = outOfReach([...new Set([...named, ...parents])], both.folders, separator);
      const path = new Set<string>([task.id, ...ancestorsOf(task, scope.tree.tasks).map((each) => each.id)]);
      const above = scope.tree.delegations
        .filter((delegation) => path.has(delegation.childTaskId))
        .map((delegation) => delegation.authority);
      return {
        given: { overrides, folders: [...both.folders] },
        above,
        decisions: both.decisions,
        lead: lead.folders,
        unreachable,
      };
    });

  /** A warning for the lead when the brief names folders the member cannot reach. Empty otherwise. */
  const outOfFolders = (member: Agent, unreachable: ReadonlyArray<string>): string =>
    unreachable.length === 0
      ? ""
      : ` Warning: the brief names ${unreachable.join(", ")}, outside ${member.name}'s folders, so ${member.name} cannot work there. ` +
        "Bring in a hob whose folders hold it, do that part yourself, or ask the user to add it to " +
        `${member.name}'s folders; name it in authority.folders if you left it out. Cancel this Task if it no longer fits.`;

  /**
   * A warning for the lead when `member` already owns an open Task under `task`, so a blocked or
   * waiting one is dealt with rather than given again as a second Task (#571). Empty otherwise.
   */
  const alreadyOpen = (tree: TaskTree, task: Task, member: Agent): string => {
    const open = tree.tasks.filter(
      (each) => each.parentId === task.id && each.ownerId === member.id && !isTerminalTask(each.state),
    );
    if (open.length === 0) return "";
    const listed = open.map((each) => `${each.id} (${each.state}): ${firstLine(each.brief)}`).join("; ");
    return ` ${member.name} already has open work under this Task: ${listed}. If the new Task repeats it, cancel one of them, or hand the open one what it needs instead.`;
  };

  /**
   * The Quest the first delegate_task call turns its Task into: the Task's brief is its goal, and
   * its work is in the folders the brief names, if any (#670).
   */
  const startQuest = (scope: CallScope, task: Task, lead: ReadonlyArray<string>, quest: QuestLimits) =>
    Effect.gen(function* () {
      const folders = yield* namedFolders(folderChecks, lead, task.brief, separator);
      return yield* fromRecords(
        tasks.startQuest({
          id: QuestId.make(newId()),
          taskId: task.id,
          goal: task.brief,
          acceptance: [],
          limits: withFolders(quest, folders),
          createdAt: scope.at,
        }),
      );
    });

  /**
   * A Task delegated by a turn on a message you sent while the work ran carries that message on, as
   * the lead's note to its hob, so the message's receipt and the hob's lane show where it went (#1005).
   */
  const carryNote = (scope: CallScope, created: Task, journal: ReturnType<typeof journalOf>) =>
    Effect.gen(function* () {
      const { messageId, steers, agentId } = scope.caller;
      if (messageId === undefined || steers === undefined || steers.trim() === "") return "";
      journal.keep(
        yield* fromRecords(
          tasks.leaveNote({
            id: NoteId.make(newId()),
            taskId: created.id,
            text: cut(steers, NOTE_LIMIT),
            createdAt: scope.at,
            senderId: agentId,
            messageId,
          }),
        ),
      );
      return " The user's message this turn answers goes with it as your note, so they can see it reached this hob.";
    });

  /**
   * What the member's session would be offered, read before the call's transaction (#1348). A
   * Charm's services and the hub's other tool sets read the database on their own, which would
   * wait on the transaction a delegation runs in, so `delegate_task` takes the offer prepared here.
   */
  const previewOffer = (scope: CallScope, input: DelegateInput) =>
    Effect.gen(function* () {
      const task = yield* ownTask(scope, input.task_id);
      const member = yield* findHob(hobs, input.hob);
      const { given, above } = yield* memberAuthority(scope, task, member, input);
      return yield* memberOffer(member, [...above, { overrides: given.overrides, folders: given.folders }]);
    });

  return {
    previewOffer,
    delegate_task: (scope: CallScope, input: DelegateInput & { readonly prepared?: SessionToolOffer | null }) =>
      Effect.gen(function* () {
        const task = yield* ownTask(scope, input.task_id);
        const member = yield* findHob(hobs, input.hob);
        yield* checkMember(scope, task, member);
        yield* capacity(scope, member.id, 1);
        const { given, above, decisions, lead, unreachable } = yield* memberAuthority(scope, task, member, input);
        // The new Delegation narrows the member last, as its session reads it once the Task starts.
        // Null when it could not be read before the call: the answer then lists nothing rather than wait.
        const offer =
          input.prepared === undefined
            ? yield* memberOffer(member, [...above, { overrides: given.overrides, folders: given.folders }])
            : (input.prepared ?? NO_OFFER);
        const tools = yield* toolsFor(member, input.authority?.decisions, { decisions, folders: given.folders }, offer);
        const timeoutMs = yield* timeoutFor(scope, task, input.timeout_minutes);
        const offered = `${offerWords(member, offer)}${briefNeeds(member, input.brief, offer)}`;
        const existing = scope.tree.quests.find((quest) => quest.taskId === task.id);
        // Refused here, not only by the records, so a check is refused as the call would be.
        yield* placeable(scope, task, input.depends_on ?? []);
        // A Quest started above this one later may allow less depth than when this one started.
        const placing =
          existing === undefined
            ? { limits: yield* questLimitsFor(scope, limits, task, {}) }
            : { existing, ...(yield* depthWithin(scope, limits, task)) };
        const linked = (input.criteria ?? []).map((id) => CriterionId.make(id));
        const unknown = linked.filter((id) => !existing?.criteria.some((each) => each.id === id));
        if (unknown.length > 0) return yield* refuse("criterion-missing", notCriteria(existing, unknown));
        if (input.check === true) {
          return {
            done: {
              message: `Checked only: nothing was delegated, and no Task started.${tools}${offered}${alreadyOpen(scope.tree, task, member)}${outOfFolders(member, unreachable)} Call delegate_task without check to delegate.`,
              details: { check: true, hob: member.name, ...offerDetails(offer) },
            },
            entries: [],
          };
        }
        const journal = journalOf();
        const quest =
          "existing" in placing ? placing.existing : journal.keep(yield* startQuest(scope, task, lead, placing.limits));
        const milestones = (input.milestones ?? []).map((title) => ({ id: MilestoneId.make(newId()), title }));
        const delegationId = DelegationId.make(newId());
        const created = journal.keep(
          yield* fromRecords(
            tasks.createTask({
              task: {
                id: TaskId.make(newId()),
                ownerId: member.id,
                parentId: task.id,
                threadId: null,
                brief: input.brief,
                dependsOn: (input.depends_on ?? []).map((id) => TaskId.make(id)),
                createdAt: scope.at,
              },
              delegation: {
                id: delegationId,
                brief: input.brief,
                expectedOutput: input.expected_output ?? null,
                authority: given,
                timeoutMs,
              },
              milestones,
            }),
          ),
        );
        if (linked.length > 0) journal.keep(yield* fromRecords(tasks.linkCriteria(quest.id, linked, created.id)));
        const carried = yield* carryNote(scope, created, journal);
        return {
          done: {
            message: `Delegated Task ${created.id} to ${member.name}.${carried} You lead Quest ${quest.id}.${tools}${offered}${alreadyOpen(scope.tree, task, member)}${outOfFolders(member, unreachable)}${existing === undefined ? planNote(task) : ""}`,
            details: {
              task_id: created.id,
              quest_id: quest.id,
              quest_started: existing === undefined,
              delegation_id: delegationId,
              milestones: milestones.map((milestone) => milestone.id as string),
              ...offerDetails(offer),
            },
          },
          entries: journal.entries,
        };
      }),

    hand_off: (scope: CallScope, input: Omit<TaskToolInput<"hand_off">, "key">) =>
      Effect.gen(function* () {
        const artifact = scope.tree.artifacts.find((each) => each.id === input.artifact_id);
        if (artifact === undefined) return yield* refuse("artifact-missing", missingArtifact(scope, input.artifact_id));
        yield* ledTask(scope, artifact.taskId);
        const to = yield* ledTask(scope, input.to_task_id);
        const journal = journalOf();
        journal.keep(yield* fromRecords(tasks.handOff(ArtifactId.make(artifact.id), to.id, scope.at)));
        return {
          done: { message: `Handed ${artifact.label} to Task ${to.id}.`, details: { artifact_id: artifact.id } },
          entries: journal.entries,
        };
      }),
  };
};
