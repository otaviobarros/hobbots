import type { Agent, ApprovalRequest, ApprovalState } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useEffect, useRef } from "react";
import { useDecideApproval } from "../../api/approvals.ts";
import { operationLabel } from "../../lib/reply-steps.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { messages } from "../messages.ts";
import { ApprovalActions } from "./approval-actions.tsx";
import { decisionErrorText, exactAction, expiryText, resultText } from "./approval-text.ts";

const copy = messages.approval;

/** The ring around the card and the color of its words, by state. */
const TONE: Record<ApprovalState, { readonly ring: string; readonly text: string; readonly motion: string }> = {
  pending: { ring: "border-lantern", text: "text-lantern", motion: "" },
  approved: { ring: "border-mint", text: "text-mint", motion: "animate-hb-pop" },
  denied: { ring: "border-rose", text: "text-rose", motion: "animate-hb-shake" },
  expired: { ring: "border-line-2", text: "text-label", motion: "" },
};

/**
 * A tool call waiting for the user, inline in the reply it paused (PE-003): the exact action, what
 * it acts on, who asked, why the policy asks now, the risk and when it expires, with Allow once,
 * Always for this site with the rule it saves, and Deny with an optional reason. It follows the durable request, so a decision made elsewhere or an expiry shows
 * here as it happens.
 */
export function ApprovalCard({ approval, hob }: { approval: ApprovalRequest; hob: Agent }) {
  const tone = TONE[approval.state];
  const pending = approval.state === "pending";
  const decide = useDecideApproval(approval);
  const sending = decide.isPending ? copy.sending : "";
  const statusText = pending ? sending : resultText(approval, hob.name);
  const status = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLElement>(null);
  // When the buttons that held focus give way to the outcome, focus moves to the outcome line
  // rather than falling back to the page.
  const hadFocus = useRef(false);
  useEffect(() => {
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    if (approval.state !== "pending" && hadFocus.current && focusLost) status.current?.focus();
  }, [approval.state]);
  return (
    <section
      ref={card}
      aria-label={copy.asks({ name: hob.name })}
      data-state={approval.state}
      onFocus={() => {
        hadFocus.current = true;
      }}
      onBlur={(event) => {
        hadFocus.current = card.current?.contains(event.relatedTarget) ?? false;
      }}
      className={cn("cut flex max-w-[560px] flex-col gap-2.5 border-[3px] bg-card px-4 py-3.5", tone.ring, tone.motion)}
    >
      <header className="flex flex-wrap items-center gap-2">
        <HobSprite hob={hob} size={22} state={pending ? "needs-you" : "idle"} />
        <span className={cn("lbl flex-1", tone.text)}>{copy.asks({ name: hob.name })}</span>
        {pending && <span className="text-xs text-label">{expiryText(approval)}</span>}
      </header>
      <ApprovalDetails approval={approval} hob={hob} />
      {pending && (
        <ApprovalActions
          approval={approval}
          hob={hob}
          pending={decide.isPending}
          onDecide={(decision) => decide.mutate(decision)}
        />
      )}
      {/* One live region for the card's whole life, so a screen reader hears each change to it. */}
      <span
        ref={status}
        role="status"
        tabIndex={-1}
        className={cn("origin-left text-sm empty:sr-only", pending ? "text-xs text-label" : tone.text)}
      >
        {statusText}
      </span>
      {pending && decide.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {decisionErrorText(decide.error)}
        </p>
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
      {/* Every turn is the user's own until delegation arrives; then the request names its chain. */}
      <dt className="text-label">{copy.askedBy}</dt>
      <dd className="m-0">{copy.chain({ name: hob.name })}</dd>
      <dt className="text-label">{copy.why}</dt>
      <dd className="m-0">{approval.reason}</dd>
      <dt className="text-label">{copy.risk}</dt>
      <dd className="m-0 flex flex-col gap-0.5">
        {approval.onceOnly && <span className="font-bold text-rose">{copy.highRisk}</span>}
        <span>{copy.riskOf[approval.operation]}</span>
      </dd>
    </dl>
  );
}
