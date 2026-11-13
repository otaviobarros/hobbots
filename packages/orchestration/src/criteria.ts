import type { CriterionCheck, EvidenceClaim, NewCriterion, TaskRepository } from "@hobbots/agents";
import {
  ArtifactId,
  type Criterion,
  CriterionId,
  hobActor,
  isAbsolutePath,
  type Quest,
  QuestionId,
  QuestStates,
  type TaskToolInput,
  unmetCriteria,
  WAIVER_CHOICES,
} from "@hobbots/domain";
import { Effect } from "effect";
import { cut } from "./briefs.ts";
import { type CallScope, fromRecords, journalOf, newId, refuse } from "./call-scope.ts";

/**
 * A Quest's acceptance criteria as its lead works with them (#1445): start_quest gives each an id,
 * delegate_task links a member's Task to some, read_tasks shows where each stands, and
 * check_criterion accepts one on evidence, sends it back for rework or waives it.
 */

/** Longest reason a check keeps. */
const REASON_LIMIT = 600;

/** The criteria start_quest's acceptance gives: a line is required, an object says whether it is optional. */
export const newCriteria = (acceptance: TaskToolInput<"start_quest">["acceptance"]): ReadonlyArray<NewCriterion> =>
  (acceptance ?? []).map((each) => ({
    id: CriterionId.make(newId()),
    text: typeof each === "string" ? each : each.text,
    required: typeof each === "string" || each.optional !== true,
  }));

/** A criterion as a lead reads it back from start_quest. */
export const criterionDetail = (criterion: NewCriterion) => ({
  criterion_id: criterion.id as string,
  text: criterion.text,
  required: criterion.required,
});

/** What start_quest tells a lead about its criteria. */
export const criteriaNote = (criteria: ReadonlyArray<NewCriterion>): string =>
  criteria.length === 0
    ? ""
    : ` Its acceptance criteria have ids (see criteria). Check each with check_criterion against the artifacts that prove it before you complete the Quest: it completes only once each required one is accepted or the user waives it.`;

/** A criterion as read_tasks shows it: where it stands, what proves it and who decided last. */
export const describeCriterion = (criterion: Criterion) => ({
  criterion_id: criterion.id as string,
  text: criterion.text,
  required: criterion.required,
  state: criterion.state,
  ...(criterion.taskIds.length === 0 ? {} : { tasks: criterion.taskIds.map((id) => id as string) }),
  ...(criterion.evidence.length === 0
    ? {}
    : {
        evidence: criterion.evidence.map((each) => ({
          artifact: each.label,
          version: each.version,
          ...(each.voidedAt === null ? {} : { voided: "a newer version replaced it" }),
        })),
      }),
  ...(criterion.decided === null
    ? {}
    : { decided: { by: criterion.decided.by.kind, reason: criterion.decided.reason, at: criterion.decided.at } }),
  ...(criterion.waiverAsk === null ? {} : { waiver_asked: { question_id: criterion.waiverAsk.questionId } }),
});

/** The Quests the caller leads in the tree, and every criterion they have. */
const ledCriteria = (scope: CallScope) => scope.tree.quests.filter((quest) => quest.leadId === scope.caller.agentId);

const unknownCriterion = (scope: CallScope, id: string) => {
  const listed = ledCriteria(scope).flatMap((quest) => quest.criteria.map((each) => `${each.id} "${each.text}"`));
  return `None of the Quests you lead here has a criterion ${id}. ${
    listed.length === 0
      ? "They have no acceptance criteria: start_quest gives them."
      : `Their criteria: ${listed.join("; ")}.`
  }`;
};

/** What is left to check on the Quest after a check, for its lead. */
const leftText = (quest: Quest) => {
  const unmet = unmetCriteria(quest.criteria);
  return unmet.length === 0
    ? "Every required criterion of the Quest is accepted or waived."
    : `${unmet.length === 1 ? "1 required criterion still holds" : `${unmet.length} required criteria still hold`} the Quest open: ${unmet.map((each) => each.id).join(", ")}.`;
};

const doneText = (verdict: TaskToolInput<"check_criterion">["verdict"], criterion: Criterion) => {
  switch (verdict) {
    case "accepted":
      return `Criterion ${criterion.id} is accepted on ${criterion.evidence
        .filter((each) => each.voidedAt === null)
        .map((each) => `"${each.label}" version ${each.version}`)
        .join(", ")}. A newer version of any of them voids it, so check it again after more work on them.`;
    case "needs-rework":
      return `Criterion ${criterion.id} needs rework. Give the work it needs to a member, or do it, then check it again.`;
    case "waived":
      return `Criterion ${criterion.id} is waived by you.`;
  }
};

/** Evidence as the records take it: an absolute path is a file, anything else a returned artifact's id. */
const claimOf = (value: string): EvidenceClaim =>
  isAbsolutePath(value) ? { _tag: "File", path: value } : { _tag: "Returned", artifactId: ArtifactId.make(value) };

/**
 * The criterion a check names, once the hub has checked it may be checked: it is on a Quest the
 * caller leads that still takes work, and acceptance names evidence.
 */
const checkable = (scope: CallScope, input: Omit<TaskToolInput<"check_criterion">, "key">) =>
  Effect.gen(function* () {
    const quest = ledCriteria(scope).find((each) => each.criteria.some((c) => c.id === input.criterion_id));
    const criterion = quest?.criteria.find((each) => each.id === input.criterion_id);
    if (quest === undefined || criterion === undefined) {
      return yield* refuse("criterion-missing", unknownCriterion(scope, input.criterion_id));
    }
    if (!QuestStates.takesWork(quest)) {
      return yield* refuse("quest-ended", `Quest ${quest.id} is ${quest.state}, so its criteria no longer change.`);
    }
    if (input.verdict === "accepted" && (input.evidence ?? []).length === 0) {
      return yield* refuse(
        "invalid-input",
        `Criterion ${criterion.id} is accepted only on evidence: name the artifacts that prove it, by the ids read_tasks lists or by their absolute paths.`,
      );
    }
    return { quest, criterion };
  });

/**
 * Only you waive a required criterion (#1445): its lead's waiver asks you, with the choices "Waive
 * it" and "Keep it", and your "Waive it" waives it. Nothing the lead says, nor the turn it says it
 * in, stands for your answer.
 */
const askToWaive = (
  tasks: TaskRepository["Service"],
  scope: CallScope,
  quest: Quest,
  criterion: Criterion,
  reason: string,
) =>
  Effect.gen(function* () {
    const journal = journalOf();
    const { quest: asked, question } = journal.keep(
      yield* fromRecords(
        tasks.askToWaive(quest.id, criterion.id, {
          questionId: QuestionId.make(newId()),
          askerId: scope.caller.agentId,
          reason,
          at: scope.at,
        }),
      ),
    );
    const now = asked.criteria.find((each) => each.id === criterion.id) ?? criterion;
    return {
      done: {
        message:
          `Criterion ${criterion.id} is required, so only the user waives it: the hub asked them, in question ${question.id}. ` +
          `If they choose "${WAIVER_CHOICES[0].label}", it is waived as theirs; you hear their answer either way. Until then it holds the Quest open.`,
        details: { quest_id: quest.id, question_id: question.id, criterion: describeCriterion(now) },
      },
      entries: journal.entries,
    };
  });

export const makeCriteria = ({ tasks }: { readonly tasks: TaskRepository["Service"] }) => ({
  check_criterion: (scope: CallScope, input: Omit<TaskToolInput<"check_criterion">, "key">) =>
    Effect.gen(function* () {
      const { quest, criterion } = yield* checkable(scope, input);
      const reason = cut(input.reason, REASON_LIMIT);
      if (input.verdict === "waived" && criterion.required) {
        return yield* askToWaive(tasks, scope, quest, criterion, reason);
      }
      const said = { by: hobActor(scope.caller.agentId), reason, at: scope.at };
      const check: CriterionCheck =
        input.verdict === "accepted"
          ? { ...said, _tag: "Accept", evidence: (input.evidence ?? []).map(claimOf) }
          : { ...said, _tag: input.verdict === "waived" ? "Waive" : "Rework" };
      const journal = journalOf();
      const checked = journal.keep(yield* fromRecords(tasks.checkCriterion(quest.id, criterion.id, check)));
      const now = checked.criteria.find((each) => each.id === criterion.id) ?? criterion;
      return {
        done: {
          message: `${doneText(input.verdict, now)} ${leftText(checked)}`,
          details: { quest_id: quest.id, criterion: describeCriterion(now) },
        },
        entries: journal.entries,
      };
    }),
});
