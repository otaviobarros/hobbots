import { AgentId, AttemptId, isLiveAttempt, type Task, type TaskTree, ThreadId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { workbenchTreeQuery } from "../../../api/workbench.ts";
import type { HobLookup } from "../../quest/use-work.ts";
import { useRoomMoves } from "../../quest-room/room-search.ts";
import { messages } from "../messages.ts";
import { attemptsOf, chosenAttempt, openingAttempt, type WorkbenchTab } from "../workbench-model.ts";
import { Made } from "./summary-made.tsx";
import { type Summary, type SummaryLine, summaryOf } from "./summary-model.ts";
import { StillOpen, useOpenReads, useTaskChat } from "./summary-open.tsx";
import { Timeline } from "./summary-timeline.tsx";

const copy = messages.summary;

/**
 * What a Task did, from the hub's records with no model call (ADR 023), in its lane's details now
 * that the lanes are the Quest's summary (ADR 027): one plain line on where it stands, what happened
 * as a timeline card, buttons to the Workbench tabs it used, what it made and what is still open, for
 * the try the Workbench follows. It reads the Quest's Workbench, the one read the docked Workbench
 * keeps live. A question for you on
 * the Task shows only in its lane, where you answer it.
 */
export function TaskSummary({ tree, task, hobs }: { tree: TaskTree; task: Task; hobs: HobLookup }) {
  const route = useParams({ strict: false });
  const hobId = AgentId.make(route.hobId ?? "");
  const threadId = ThreadId.make(route.threadId ?? "");
  const topId = tree.tasks[0]?.id ?? task.id;
  const room = useRoomMoves(hobId, threadId, topId);
  const toChat = useTaskChat(tree, hobId, threadId);
  const reads = useOpenReads(task.threadId);
  const read = useQuery(workbenchTreeQuery(topId));
  const recorded = read.data?.activity.attempts ?? [];
  const activityOf = (id: string) => recorded.find((each) => each.activity.attempt.id === id)?.activity;
  // The try picked for the Task, as the Workbench follows it, else the latest that recorded work.
  const picked = useSearch({ strict: false }).attempt;
  const attempts = attemptsOf(tree, task);
  const attempt = chosenAttempt(attempts, picked === undefined ? undefined : AttemptId.make(picked), () =>
    openingAttempt(tree, task, attempts, (each) => activityOf(each.id) ?? "unread"),
  );
  const activity = attempt === null ? null : (activityOf(attempt.id) ?? null);
  const summary = summaryOf(tree, task, attempt, activity, reads.approvals);
  const owner = hobs(task.ownerId).name;
  const running = attempt !== null && isLiveAttempt(attempt.state);
  // A try picked for the Task stays picked as its summary opens the Workbench on it.
  const onTab = (tab: WorkbenchTab, file?: string) =>
    room.show(task.id, tab, {
      ...(file === undefined ? {} : { file }),
      ...(picked === undefined ? {} : { attempt: picked }),
    });
  return (
    <div data-slot="summary" className="flex flex-col gap-4">
      <Line line={summary.line} owner={owner} hobs={hobs} />
      <Timeline summary={summary} owner={owner} running={running} hobs={hobs} onOpen={room.lane} />
      <TabButtons used={summary.used} onTab={onTab} />
      <Section title={copy.made}>
        <Made
          summary={summary}
          owner={owner}
          running={running}
          reading={attempt !== null && activity === null}
          onTab={onTab}
        />
      </Section>
      <Section title={copy.open}>
        <StillOpen
          summary={summary}
          tree={tree}
          task={task}
          hobs={hobs}
          reads={reads}
          onChat={toChat}
          onTask={room.lane}
        />
      </Section>
    </div>
  );
}

/** The line the summary leads with: the Task's result, or where the Attempt shown stands. */
function Line({ line, owner, hobs }: { line: SummaryLine; owner: string; hobs: HobLookup }) {
  const lead = (() => {
    switch (line.kind) {
      case "result":
        return line.summary;
      case "not-started":
        return copy.line.notStarted({ name: owner });
      case "asks":
        return copy.line.asks({ name: hobs(line.asker).name });
      case "working":
        return copy.line.working({ name: owner, number: line.attempt });
      case "waiting":
        return copy.line.waiting({ name: owner, number: line.attempt });
      case "ended":
        return copy.line.ended[line.mark]({ number: line.attempt });
      case "no-result":
        return copy.noResult;
    }
  })();
  return (
    <div data-slot="summary-line" className="flex flex-col gap-1">
      <p className="m-0 text-body whitespace-pre-wrap text-text-strong">
        {lead}
        {line.earlier > 0 && ` ${copy.line.earlier({ count: line.earlier })}`}
      </p>
      {line.kind === "result" && line.from !== null && (
        <span className="text-meta text-label">{copy.resultFrom({ number: line.from })}</span>
      )}
    </div>
  );
}

/** Buttons to the tabs the Task used, naming what each holds. */
function TabButtons({ used, onTab }: { used: Summary["used"]; onTab: (tab: WorkbenchTab) => void }) {
  if (used.changes + used.files + used.commands === 0) return null;
  return (
    <nav aria-label={copy.tabs} className="flex flex-wrap gap-2">
      {used.changes > 0 && (
        <Button variant="outline" size="sm" onClick={() => onTab("changes")}>
          {copy.seeChanges({ count: used.changes })}
        </Button>
      )}
      {used.files > 0 && (
        <Button variant="outline" size="sm" onClick={() => onTab("files")}>
          {copy.seeFiles({ count: used.files })}
        </Button>
      )}
      {used.commands > 0 && (
        <Button variant="outline" size="sm" onClick={() => onTab("terminal")}>
          {copy.seeTerminal}
        </Button>
      )}
    </nav>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="lbl m-0 text-meta text-label">{title}</h3>
      {children}
    </section>
  );
}
