import type { TaskId } from "@hobbots/domain";
import { QuestTicket } from "../quest-ticket/quest-ticket.tsx";
import type { WorkbenchTab } from "../workbench/workbench-model.ts";
import { LeadAnsweredLine, QuestionCard } from "./question-card.tsx";
import type { HobLookup } from "./use-work.ts";
import type { Moment } from "./work-model.ts";

/**
 * What the chat shows of a request's work under one message: its ticket, a question you answered
 * or that was withdrawn, or a lead's answer that spared you one. A question still open waits in the
 * Needs-you tray. Everything else lives in the quest's sheet (ADR 027).
 */
export function WorkMoments({
  moments,
  hobs,
  onOpen,
}: {
  moments: ReadonlyArray<Moment>;
  hobs: HobLookup;
  /** Opens the quest on a Task in the sheet, or its Workbench on a tab if one is named. */
  onOpen: (taskId: TaskId, options?: { readonly tab?: WorkbenchTab }) => void;
}) {
  return moments.map((moment) =>
    moment.kind === "ticket" ? (
      <QuestTicket key={`ticket-${moment.tree.tasks[0]?.id}`} tree={moment.tree} hobs={hobs} onOpen={onOpen} />
    ) : moment.kind === "question" ? (
      moment.question.state === "open" ? null : (
        <QuestionCard
          key={`question-${moment.question.id}`}
          tree={moment.tree}
          question={moment.question}
          hobs={hobs}
          onOpen={onOpen}
        />
      )
    ) : (
      <LeadAnsweredLine key={`answered-${moment.question.id}`} question={moment.question} hobs={hobs} />
    ),
  );
}
