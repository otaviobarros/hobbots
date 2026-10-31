import type { Agent, ApprovalRequest, ApprovalState } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type Decision, useDecideApproval } from "../../api/approvals.ts";
import { operationLabel } from "../../lib/reply-steps.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "../messages.ts";
import { decisionErrorText, exactAction, resultText } from "./approval-text.ts";

const copy = messages.approval;

// Stable, so each runs once when its element mounts rather than on every render.
const revealOnMount = (element: HTMLElement | null) => element?.scrollIntoView({ block: "nearest" });
const focusOnMount = (element: HTMLElement | null) => element?.focus();

/** The ring around the card and the color of its words, by state. */
const TONE: Record<ApprovalState, { readonly ring: string; readonly text: string; readonly motion: string }> = {
  pending: { ring: "border-lantern", text: "text-lantern", motion: "" },
  approved: { ring: "border-mint", text: "text-mint", motion: "animate-hb-pop" },
  denied: { ring: "border-rose", text: "text-rose", motion: "animate-hb-shake" },
  expired: { ring: "border-line-2", text: "text-label", motion: "" },
};

/**
 * A tool call waiting for the user, inline in the reply it paused (PE-003): the exact action, what
 * it acts on, who asked, why the policy asks now and the risk, with Allow once and Deny with an
 * optional reason. It follows the durable request, so a decision made elsewhere or an expiry shows
 * here as it happens.
 */
export function ApprovalCard({ approval, hob }: { approval: ApprovalRequest; hob: Agent }) {
  const tone = TONE[approval.state];
  const pending = approval.state === "pending";
  return (
    <section
      // A pending request scrolls into view, so a paused reply never waits unseen below the fold.
      ref={pending ? revealOnMount : undefined}
      aria-label={copy.asks({ name: hob.name })}
      data-state={approval.state}
      className={cn("cut flex max-w-[560px] flex-col gap-2.5 border-[3px] bg-card px-4 py-3.5", tone.ring, tone.motion)}
    >
      <header className="flex flex-wrap items-center gap-2">
        <HobSprite hob={hob} size={22} state={pending ? "needs-you" : "idle"} />
        <span className={cn("lbl flex-1", tone.text)}>{copy.asks({ name: hob.name })}</span>
        {pending && <span className="text-xs text-label">{copy.expires}</span>}
      </header>
      <ApprovalDetails approval={approval} hob={hob} />
      {pending ? (
        <ApprovalActions approval={approval} hob={hob} />
      ) : (
        <span role="status" className={cn("origin-left text-sm", tone.text)}>
          {resultText(approval, hob.name)}
        </span>
      )}
    </section>
  );
}

function ApprovalDetails({ approval, hob }: { approval: ApprovalRequest; hob: Agent }) {
  const action = exactAction(approval);
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-label">{copy.action}</dt>
      <dd className="m-0 flex flex-col gap-0.5">
        <span>{operationLabel(approval.operation)}</span>
        <code className="bg-deep px-2 py-1 font-mono text-[13px] break-all whitespace-pre-wrap">{action}</code>
      </dd>
      <dt className="text-label">{copy.target}</dt>
      <dd className="m-0 break-all">{approval.targets.length === 0 ? copy.noTarget : approval.targets.join(", ")}</dd>
      <dt className="text-label">{copy.askedBy}</dt>
      <dd className="m-0">{copy.chain({ name: hob.name })}</dd>
      <dt className="text-label">{copy.why}</dt>
      <dd className="m-0">{approval.reason}</dd>
      <dt className="text-label">{copy.risk}</dt>
      <dd className="m-0">{copy.riskOf[approval.operation]}</dd>
    </dl>
  );
}

function ApprovalActions({ approval, hob }: { approval: ApprovalRequest; hob: Agent }) {
  const decide = useDecideApproval(approval);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const denyButton = useRef<HTMLButtonElement>(null);
  const send = (decision: Decision) => decide.mutate(decision);
  // Closing the reason brings the buttons back, with focus on Deny where it was.
  const closeDeny = () => {
    flushSync(() => setDenying(false));
    denyButton.current?.focus();
  };
  return (
    <div className="flex flex-col gap-2">
      {denying ? (
        <DenyForm
          name={hob.name}
          reason={reason}
          onReason={setReason}
          pending={decide.isPending}
          onDeny={() => send({ decision: "deny", reason })}
          onCancel={closeDeny}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="approve" disabled={decide.isPending} onClick={() => send({ decision: "approve" })}>
            {copy.allowOnce}
          </Button>
          <Button ref={denyButton} variant="deny" disabled={decide.isPending} onClick={() => setDenying(true)}>
            {copy.deny}
          </Button>
        </div>
      )}
      {decide.isPending && (
        <span role="status" className="text-xs text-label">
          {copy.sending}
        </span>
      )}
      {decide.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {decisionErrorText(decide.error)}
        </p>
      )}
    </div>
  );
}

/** The optional reason that goes back to the hob with a Deny. Escape closes it. */
function DenyForm({
  name,
  reason,
  onReason,
  pending,
  onDeny,
  onCancel,
}: {
  name: string;
  reason: string;
  onReason: (reason: string) => void;
  pending: boolean;
  onDeny: () => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onDeny();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <label htmlFor={inputId} className="text-xs text-label">
        {copy.reasonLabel({ name })}
      </label>
      <span className="flex flex-wrap gap-2">
        <input
          id={inputId}
          ref={focusOnMount}
          value={reason}
          maxLength={2000}
          onChange={(event) => onReason(event.target.value)}
          className="min-w-[200px] flex-1 border-2 border-control bg-deep px-3 py-1.5 text-text"
        />
        <Button type="submit" variant="deny" disabled={pending}>
          {copy.confirmDeny}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </span>
    </form>
  );
}
