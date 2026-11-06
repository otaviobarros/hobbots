import { type FolderChecksShape, type HobbotsRepository, openTools, type TaskRepository } from "@hobbots/agents";
import {
  type Agent,
  AgentId,
  ArtifactId,
  ancestorsOf,
  DelegationId,
  isTerminalTask,
  MilestoneId,
  NoteId,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type PolicyOperation,
  type PolicyOverrides,
  type Quest,
  QuestId,
  questsAbove,
  type Task,
  TaskId,
  type TaskToolInput,
  type TaskToolRefused,
  type TaskTree,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { type Authority, delegatedAuthority, narrowBy, type PathSeparator } from "./authority.ts";
import { cut, firstLine, planNote } from "./briefs.ts";
import {
  type CallScope,
  depthWithin,
  fromRecords,
  journalOf,
  ledTask,
  newId,
  ownTask,
  questLimitsFor,
  refuse,
  type TaskToolLimits,
} from "./call-scope.ts";
import { defaultFolders, namedFolders, withFolders } from "./default-folders.ts";

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
}

type DelegateInput = Omit<TaskToolInput<"delegate_task">, "key">;

/** Longest text of yours a delegated Task carries on as its lead's note. */
const NOTE_LIMIT = 2_000;

/** A hob that can take work, by its id or its name. */
const findHob = (hobs: Deps["hobs"], named: string): Effect.Effect<Agent, TaskToolRefused> =>
  Effect.gen(function* () {
    const byId = yield* hobs.findAgent(AgentId.make(named));
    const wanted = named.trim().toLowerCase();
    const hob = Option.isSome(byId)
      ? byId.value
      : (yield* hobs.listAgents).find((agent) => agent.name.trim().toLowerCase() === wanted);
    if (hob === undefined) return yield* refuse("hob-missing", `There is no hob named ${named}.`);
    if (hob.status !== "active")
      return yield* refuse("hob-missing", `${hob.name} is ${hob.status} and cannot take work.`);
    return hob;
  });

/** Checks the member can take this Task: not the caller itself, and not a hob that already leads its lineage. */
const checkMember = (scope: CallScope, task: Task, member: Agent) => {
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
const FILE_OPERATIONS: ReadonlyArray<PolicyOperation> = ["read-files", "edit-files"];

/**
 * What the member's tools will be under `decisions`, in words for the lead, refusing a request whose
 * own answers open commands and close the file operations they run with, so no member is given work
 * it has no tool for (#661). The same gap left by the lead's or the member's own policy is a warning.
 * With no folder, or reading denied, the member's turns are chat-only, as `toolTurn` makes them.
 * Commands also need the member's sandbox, which is decided when its turn starts.
 */
const toolsFor = (
  member: Agent,
  asked: PolicyOverrides | undefined,
  { decisions, folders }: Pick<Authority, "decisions" | "folders">,
) => {
  const open = openTools((operation) => decisions[operation]);
  const chatOnly =
    folders.length === 0 ? "no folder is both yours and its own" : open.read ? null : "it would have read-files deny";
  const tools = [
    [open.read, "file reads"],
    [open.edit, "file edits"],
    [open.commands, "commands"],
    [open.gitInit, "git_init"],
  ] as const;
  const has = tools.flatMap(([on, name]) => (on ? [name] : []));
  const lacks = tools.flatMap(([on, name]) => (on ? [] : [`no ${name}`]));
  const summary =
    chatOnly === null
      ? ` ${member.name} will have: ${[has.join(", "), ...(lacks.length === 0 ? [] : [lacks.join(", ")])].join("; ")}.`
      : ` ${member.name} will have no tools: ${chatOnly}, so its turns are chat-only. Do the Task's file work yourself, or give it work that needs no files.`;
  const commands = COMMAND_OPERATIONS.filter((operation) => decisions[operation] !== "deny");
  if (open.commands || commands.length === 0) return Effect.succeed(summary);
  const closing = FILE_OPERATIONS.filter((operation) => decisions[operation] !== "allow");
  const rule = `commands, Git's included, need read-files and edit-files both allow, and ${member.name} would have ${closing.map((operation) => `${operation} ${decisions[operation]}`).join(" and ")}`;
  // Refused only when the request's own answers make the gap; one the lead or member already has warns.
  const gives = commands.filter((operation) => asked?.[operation] !== undefined);
  const takes = closing.filter((operation) => (asked?.[operation] ?? "allow") !== "allow");
  if (gives.length > 0 && takes.length > 0) {
    return refuse(
      "authority-unusable",
      `${member.name} could not use ${gives.join(" or ")}: ${rule}. Give ${takes.join(" and ")} allow, or give ${gives.join(" and ")} deny and run the commands yourself.${summary}`,
    );
  }
  if (chatOnly !== null) return Effect.succeed(summary);
  return Effect.succeed(
    `${summary} It cannot use ${commands.join(" or ")} though it has them: ${rule}. Run any commands the Task needs yourself.`,
  );
};

/** Tools a lead brings in other hobs and moves results between them with. */
export const makeDelegating = ({ tasks, hobs, folderChecks, capacity, authority, limits, separator }: Deps) => {
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
        POLICY_OPERATIONS.flatMap((operation) =>
          narrowed.authority.overrides[operation] === undefined ? [] : [[operation, both.decisions[operation]]],
        ),
      );
      return { given: { overrides, folders: [...both.folders] }, decisions: both.decisions, lead: lead.folders };
    });

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
  const startQuest = (scope: CallScope, task: Task, lead: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const quest = yield* questLimitsFor(scope, limits, task, {});
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

  return {
    delegate_task: (scope: CallScope, input: DelegateInput) =>
      Effect.gen(function* () {
        const task = yield* ownTask(scope, input.task_id);
        const member = yield* findHob(hobs, input.hob);
        yield* checkMember(scope, task, member);
        yield* capacity(scope, member.id, 1);
        const { given, decisions, lead } = yield* memberAuthority(scope, task, member, input);
        const tools = yield* toolsFor(member, input.authority?.decisions, { decisions, folders: given.folders });
        const timeoutMs = yield* timeoutFor(scope, task, input.timeout_minutes);
        const journal = journalOf();
        const existing = scope.tree.quests.find((quest) => quest.taskId === task.id);
        // A Quest started above this one later may allow less depth than when this one started.
        if (existing !== undefined) yield* depthWithin(scope, limits, task);
        const quest = existing ?? journal.keep(yield* startQuest(scope, task, lead));
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
        const carried = yield* carryNote(scope, created, journal);
        return {
          done: {
            message: `Delegated Task ${created.id} to ${member.name}.${carried} You lead Quest ${quest.id}.${tools}${alreadyOpen(scope.tree, task, member)}${existing === undefined ? planNote(task) : ""}`,
            details: {
              task_id: created.id,
              quest_id: quest.id,
              quest_started: existing === undefined,
              delegation_id: delegationId,
              milestones: milestones.map((milestone) => milestone.id as string),
            },
          },
          entries: journal.entries,
        };
      }),

    hand_off: (scope: CallScope, input: Omit<TaskToolInput<"hand_off">, "key">) =>
      Effect.gen(function* () {
        const artifact = scope.tree.artifacts.find((each) => each.id === input.artifact_id);
        if (artifact === undefined) {
          return yield* refuse("artifact-missing", `No artifact ${input.artifact_id} in the work you are on.`);
        }
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
