import type { HobProposalRow } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef } from "react";
import { hobProposalQuery } from "../../api/hob-proposals.ts";
import { agentsQuery } from "../../api/queries.ts";
import { messages as proposalCopy } from "../hob-proposal/messages.ts";
import { Summon } from "./summon.tsx";
import type { SummonStep } from "./summon-model.ts";

/**
 * Summon opened on a summon row of a hob proposal (ADR 034, Asking is a proposal): your version of
 * the manager's draft, allowed from the last step. A row that is gone or decided says so instead.
 */
export function SummonProposalRow({
  proposalId,
  rowId,
  step,
  onStep,
}: {
  proposalId: string;
  rowId: string;
  step: SummonStep;
  onStep: (step: SummonStep) => void;
}) {
  const view = useQuery(hobProposalQuery(proposalId));
  const hobs = useQuery(agentsQuery);
  // The row as it waited: once you allow it here, it reads as allowed while the hob's page opens.
  const waited = useRef<HobProposalRow | undefined>(undefined);
  if (view.isPending) {
    return <main className="flex flex-1 items-center justify-center text-text-secondary">{proposalCopy.loading}</main>;
  }
  const { proposal } = view.data ?? {};
  const found = proposal?.rows.find((candidate) => candidate.id === rowId);
  if (found?.state === "pending") waited.current = found;
  const row = found?.state === "pending" ? found : waited.current;
  if (proposal === undefined || row === undefined || proposal.kind !== "summon") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 text-text-secondary">
        <p className="m-0">{view.isError ? proposalCopy.loadFailed : proposalCopy.editing.missing}</p>
        <Link to="/inbox">{proposalCopy.editing.backToInbox}</Link>
      </main>
    );
  }
  const who = hobs.data?.find((hob) => hob.id === proposal.agentId)?.name ?? proposalCopy.what.unknown;
  return <Summon step={step} onStep={onStep} editing={{ proposalId, row, who }} />;
}
