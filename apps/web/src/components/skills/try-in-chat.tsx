import type { SkillTrialDraftPayload } from "@hobbots/api";
import type { Agent, AgentId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@hobbots/ui/components/menu";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { agentsQuery } from "../../api/queries.ts";
import { useStartTrial } from "../../api/skill-trials.ts";
import { HobMenuItems } from "../hob-sprite/hob-menu-items.tsx";
import { messages } from "./messages.ts";
import { trialErrorText, trialHobs } from "./try-in-chat-model.ts";

const copy = messages.trial;

function HobChoices({ first, onPick }: { first: AgentId | null; onPick: (hob: Agent) => void }) {
  const hobs = useQuery(agentsQuery);
  if (hobs.isError) {
    return (
      <DropdownMenuItem
        inset
        onSelect={(event) => {
          // Stays open on the hobs once they are read.
          event.preventDefault();
          void hobs.refetch();
        }}
      >
        {copy.hobsFailed} {copy.tryAgain}
      </DropdownMenuItem>
    );
  }
  if (hobs.data === undefined) return <DropdownMenuLabel>{copy.loadingHobs}</DropdownMenuLabel>;
  const choices = trialHobs(hobs.data, first);
  if (choices.length === 0) return <DropdownMenuLabel>{copy.noHobs}</DropdownMenuLabel>;
  return <HobMenuItems hobs={choices} onPick={onPick} />;
}

/**
 * Try in a chat (ADR 029, #1099): picks a hob and opens a new chat with it where only the draft is
 * loaded, before anyone else gets it. `draft` is read when you pick, so the chat tries the text as it
 * is then. `first` is the hob to offer first, such as the one that proposed the draft.
 */
export function TryInChat({
  draft,
  first = null,
  disabled = false,
}: {
  draft: () => SkillTrialDraftPayload;
  first?: AgentId | null;
  disabled?: boolean;
}) {
  const start = useStartTrial();
  const navigate = useNavigate();
  const pick = (hob: Agent) =>
    start.mutate(
      { agentId: hob.id, draft: draft() },
      {
        onSuccess: (thread) =>
          void navigate({ to: "/hobs/$hobId/threads/$threadId", params: { hobId: hob.id, threadId: thread.id } }),
      },
    );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" disabled={disabled || start.isPending}>
            {start.isPending ? copy.starting : copy.button}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{copy.menu}</DropdownMenuLabel>
          <p className="m-0 max-w-64 px-2 pb-1.5 text-meta text-label">{copy.hint}</p>
          <HobChoices first={first} onPick={pick} />
        </DropdownMenuContent>
      </DropdownMenu>
      {start.isError && (
        <p role="alert" className="m-0 basis-full text-meta text-rose">
          {trialErrorText(start.error)}
        </p>
      )}
    </>
  );
}
