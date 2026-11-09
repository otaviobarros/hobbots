import type { OpenWork } from "@hobbots/api";
import type { Agent, AgentId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useId } from "react";
import { handOverBlockText } from "../../api/profile.ts";
import { messages } from "../messages.ts";
import { taskTitle } from "../quest/work-model.ts";

/**
 * What the hob has open: its running replies, its open Tasks (with why one cannot go to the hob
 * picked for a hand-over), and how many approvals and backpack items wait.
 */
export function OpenWorkList({
  running,
  work,
  blockedTaker,
}: {
  running: ReadonlyArray<string>;
  work: OpenWork | undefined;
  blockedTaker: Agent | null;
}) {
  const copy = messages.profile.retire;
  const tasks = work?.tasks ?? [];
  const approvals = work?.approvals.length ?? 0;
  const items = work?.backpackItems.length ?? 0;
  if (running.length === 0 && tasks.length === 0 && approvals === 0 && items === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-control bg-deep px-3 py-2 text-ui">
      {running.length > 0 && <span className="lbl text-label">{copy.runningHeading}</span>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {running.map((title, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two running threads may share a title.
          <li key={i} className="truncate">
            {title}
          </li>
        ))}
      </ul>
      {tasks.length > 0 && <span className="lbl text-label">{copy.tasksHeading({ count: tasks.length })}</span>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {tasks.map((task) => (
          <li key={task.id} className="flex min-w-0 flex-col">
            <span className="truncate">{taskTitle(task)}</span>
            {blockedTaker !== null && task.handOver != null && (
              <span className="text-detail text-rose">{handOverBlockText(task.handOver, blockedTaker.name)}</span>
            )}
          </li>
        ))}
      </ul>
      {(approvals > 0 || items > 0) && (
        <span className="text-detail text-text-secondary">{copy.waitingOn({ approvals, items })}</span>
      )}
    </div>
  );
}

/** The hob that takes the open Tasks in a hand-over: any other hob that takes new work. */
export function HandOverPicker({
  takers,
  value,
  disabled,
  onPick,
  blocked,
  taker,
}: {
  takers: ReadonlyArray<Agent>;
  value: AgentId | null;
  disabled: boolean;
  onPick: (agentId: AgentId) => void;
  blocked: number;
  taker: string | null;
}) {
  const copy = messages.profile.retire;
  const selectId = useId();
  if (takers.length === 0) return <span className="text-ui text-text-secondary">{copy.noTaker}</span>;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <label htmlFor={selectId} className="text-ui text-text">
          {copy.handTo}
        </label>
        <select
          id={selectId}
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) => onPick(event.target.value as AgentId)}
          className="min-w-0 rounded-control border-(length:--edge) border-control bg-deep px-2 py-1 text-ui text-text-strong"
        >
          <option value="" disabled>
            {copy.pickTaker}
          </option>
          {takers.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
      </span>
      {blocked > 0 && taker !== null && (
        <span role="alert" className="text-detail text-rose">
          {copy.cannotTake({ taker, count: blocked })}
        </span>
      )}
    </div>
  );
}

/** One way to retire, as a row; the picked one is filled. */
export function RetireChoiceRow({
  checked,
  title,
  note,
  onPick,
}: {
  checked: boolean;
  title: string;
  note: string;
  onPick: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-0.5 rounded-control px-3 py-2 transition-colors duration-(--dur-fade) ease-(--ease-ui)",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus-ring",
        checked ? "bg-line text-text-strong" : "bg-card text-text hover:bg-hover",
      )}
    >
      <input type="radio" name="retire-work" checked={checked} onChange={onPick} className="sr-only" />
      <strong className="text-ui">{title}</strong>
      <span className="text-detail text-text-secondary">{note}</span>
    </label>
  );
}
