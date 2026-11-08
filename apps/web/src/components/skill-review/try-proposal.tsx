import type { SkillProposalView } from "@hobbots/api";
import { useState } from "react";
import { TryInChat } from "../skills/try-in-chat.tsx";

/**
 * Try in a chat (ADR 029, #1099): the proposal, or your edit of it, loaded alone in a new chat, the
 * hob that proposed it offered first.
 */
export function TryProposal({
  proposal,
  instructions,
  disabled,
}: {
  proposal: SkillProposalView["proposal"];
  /** Your edit as it stands, or null for the proposal as the hob made it. */
  instructions: string | null;
  disabled: boolean;
}) {
  return (
    <TryInChat
      first={proposal.agentId}
      disabled={disabled}
      draft={() => ({
        _tag: "Proposal",
        proposalId: proposal.id,
        ...(instructions === null ? {} : { instructions }),
      })}
    />
  );
}

/**
 * Edit then add as it stands: whether you are editing, your edit, and the text the editor opens on,
 * which is the text you tried in a chat when you came back from one (ADR 029, Try in a chat).
 */
export const useProposalEdit = (proposal: SkillProposalView["proposal"], tried: string | null) => {
  const start = tried ?? proposal.instructions;
  const [editing, setEditing] = useState(tried !== null);
  // Your edit as it stands, which Try in a chat loads while you edit.
  const [edited, setEdited] = useState(start);
  // What Edit then add opens on: the text you tried, until you go back to the proposal as it came.
  const [opening, setOpening] = useState(start);
  return { editing, setEditing, edited, setEdited, opening, setOpening };
};
