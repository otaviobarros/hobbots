import type { Agent, AgentId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { sidebarQuery } from "../../api/sidebar.ts";
import { HobPicker } from "./hob-picker.tsx";
import { messages } from "./messages.ts";

const copy = messages.picker;

/** The hobs the camp is made with (ADR 039, Members), picked in order, with why the first leads. */
export function MembersField({
  hobs,
  picked,
  locked,
  problem,
  failed,
  onRetry,
  onToggle,
}: {
  hobs: ReadonlyArray<Agent>;
  picked: ReadonlyArray<AgentId>;
  locked: AgentId | null;
  problem: string | undefined;
  failed: boolean;
  onRetry: () => void;
  onToggle: (id: AgentId) => void;
}) {
  const you = useQuery(sidebarQuery).data?.you;
  const membersId = useId();
  const noteId = `${membersId}-note`;
  return (
    <div className="flex flex-col gap-1.5">
      <span id={membersId} className="lbl text-meta text-label">
        {copy.label}
      </span>
      <HobPicker
        you={you}
        hobs={hobs}
        picked={picked}
        locked={locked}
        labelledBy={membersId}
        describedBy={noteId}
        onToggle={onToggle}
      />
      {failed && (
        <span role="alert" className="flex items-center gap-2 text-meta text-rose">
          {copy.failed}
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            {copy.retry}
          </Button>
        </span>
      )}
      {problem !== undefined ? (
        <span id={noteId} role="alert" className="text-meta text-rose">
          {problem}
        </span>
      ) : (
        <span id={noteId} className="text-meta text-label">
          {copy.note}
        </span>
      )}
    </div>
  );
}
