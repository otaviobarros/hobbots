import type { FolderChecksShape, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import {
  type Agent,
  AgentId,
  ArtifactId,
  ancestorsOf,
  DelegationId,
  MilestoneId,
  type Quest,
  QuestId,
  questChain,
  type Task,
  TaskId,
  type TaskToolInput,
  type TaskToolRefused,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { type Authority, delegatedAuthority, narrowBy } from "./authority.ts";
import {
  type CallScope,
  fromRecords,
  journalOf,
  ledTask,
  newId,
  ownTask,
  questLimitsFor,
  refuse,
  type TaskToolLimits,
} from "./call-scope.ts";

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
}

type DelegateInput = Omit<TaskToolInput<"delegate_task">, "key">;

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

/** The Quest on `task`, if it has one, and every Quest above it, nearest first. */
const questsAround = (scope: CallScope, task: Task): ReadonlyArray<Quest> => {
  const path = new Set([task.id, ...ancestorsOf(task, scope.tree.tasks).map((each) => each.id)]);
  const nearest = [task, ...ancestorsOf(task, scope.tree.tasks)]
    .map((each) => scope.tree.quests.find((quest) => quest.taskId === each.id))
    .find((quest) => quest !== undefined);
  return nearest === undefined ? [] : questChain(nearest, scope.tree.quests).filter((q) => path.has(q.taskId));
};

/** Checks the member can take this Task: not the caller itself, and not a hob that already leads its lineage. */
const checkMember = (scope: CallScope, task: Task, member: Agent) => {
  if (member.id === scope.caller.agentId) {
    return refuse("own-hob", "You cannot delegate to yourself. Split your own work with plan_steps.");
  }
  const lineage = [task, ...ancestorsOf(task, scope.tree.tasks)];
  if (lineage.some((each) => each.ownerId === member.id)) {
    return refuse("cycle", `${member.name} already owns work this Task is part of, so it cannot be given part of it.`);
  }
  const passed = questsAround(scope, task).find(
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

/** Tools a lead brings in other hobs and moves results between them with. */
export const makeDelegating = ({ tasks, hobs, folderChecks, capacity, authority, limits }: Deps) => {
  /**
   * The member's authority: the caller's on this Task, narrowed by what the brief asks for and by
   * the member's own policy, so it holds the intersection of the lead's and its own (STD-SEC-003).
   */
  const memberAuthority = (scope: CallScope, task: Task, member: Agent, requested: DelegateInput["authority"]) =>
    Effect.gen(function* () {
      const folders =
        requested?.folders === undefined
          ? undefined
          : yield* Effect.forEach(requested.folders, (folder) =>
              folderChecks
                .check(folder)
                .pipe(Effect.catch(() => refuse("invalid-input", `${folder} is not a folder on this hub.`))),
            );
      const narrowed = delegatedAuthority(yield* authority.of(scope, task), {
        ...(requested?.decisions === undefined ? {} : { decisions: requested.decisions }),
        ...(folders === undefined ? {} : { folders }),
      });
      if (narrowed._tag === "Wider") return yield* refuse("authority-wider", narrowed.message);
      const own = yield* authority.own(member.id);
      const both = narrowBy(own, narrowed.authority);
      return { overrides: both.decisions, folders: [...both.folders] };
    });

  return {
    delegate_task: (scope: CallScope, input: DelegateInput) =>
      Effect.gen(function* () {
        const task = yield* ownTask(scope, input.task_id);
        const member = yield* findHob(hobs, input.hob);
        yield* checkMember(scope, task, member);
        yield* capacity(scope, member.id, 1);
        const given = yield* memberAuthority(scope, task, member, input.authority);
        const timeoutMs = yield* timeoutFor(scope, task, input.timeout_minutes);
        const journal = journalOf();
        const existing = scope.tree.quests.find((quest) => quest.taskId === task.id);
        const quest =
          existing ??
          journal.keep(
            yield* fromRecords(
              tasks.startQuest({
                id: QuestId.make(newId()),
                taskId: task.id,
                goal: task.brief,
                acceptance: [],
                limits: yield* questLimitsFor(scope, limits, task, {}),
                createdAt: scope.at,
              }),
            ),
          );
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
        return {
          done: {
            message: `Delegated Task ${created.id} to ${member.name}. You lead Quest ${quest.id}.`,
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
