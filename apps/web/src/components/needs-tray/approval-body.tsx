import type { ApprovalSurface } from "@hobbots/domain";
import { useRef } from "react";
import { useDecideApproval } from "../../api/approvals.ts";
import { ApprovalActions } from "../approvals/approval-actions.tsx";
import { riskOf } from "../approvals/approval-rules.ts";
import { decisionErrorText, expiryText } from "../approvals/approval-text.ts";
import { messages as appCopy } from "../messages.ts";
import { useMoveOn } from "../move-on/move-on.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { TrayAction } from "../web/web-ask-parts.tsx";
import { Details } from "./details.tsx";
import { messages } from "./messages.ts";
import type { TrayEntry } from "./tray-entries.ts";
import { trayTargets } from "./tray-focus.ts";

const copy = messages;
const approvalCopy = appCopy.approval;

type Hob = ReturnType<HobLookup>;

/** A request in the tray: what it asks to do, its answers, and why, its risk and who asked. */
export function ApprovalBody({
  entry,
  asker,
  via,
}: {
  entry: Extract<TrayEntry, { kind: "approval" }>;
  asker: Hob;
  via: ApprovalSurface;
}) {
  const { request } = entry;
  const decide = useDecideApproval(request, via);
  const area = useRef<HTMLDivElement>(null);
  const moveOn = useMoveOn();
  return (
    <div ref={area} className="contents">
      <TrayAction request={request} name={asker.name} />
      <ApprovalActions
        approval={request}
        hob={asker}
        pending={decide.isPending}
        // The decision's line shows in the transcript, so the tray says nothing more.
        onDecide={(decision) =>
          moveOn({ from: area.current, targets: trayTargets, sent: decide.mutateAsync(decision) })
        }
        look="tray"
      />
      {decide.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {decisionErrorText(decide.error)}
        </p>
      )}
      <Details summary={copy.details.approval}>
        <span className="flex flex-col gap-1">
          <span>
            {approvalCopy.targetLine({
              target: request.targets.length === 0 ? approvalCopy.noTarget : request.targets.join(", "),
            })}
          </span>
          <span>{approvalCopy.askedByLine({ chain: approvalCopy.chain({ name: asker.name }) })}</span>
          <span>{approvalCopy.riskLine({ risk: riskOf(request.operation) })}</span>
          <span>{expiryText(request)}</span>
        </span>
      </Details>
    </div>
  );
}
