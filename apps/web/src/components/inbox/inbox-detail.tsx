import type { Agent, ApprovalRequest } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import { formatWhen } from "../../lib/time.ts";
import { ApprovalCard } from "../approvals/approval-card.tsx";
import { HobSprite } from "../hob-sprite.tsx";
import { expiryText, requestTitle } from "./inbox-items.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * One request in full: who asked, in which thread, when it was asked and when it expires, then the
 * same approval card the chat shows, so deciding here works exactly as it does there (ADR 015).
 */
export function InboxDetail({
  request,
  hob,
  threadTitle,
  now,
}: {
  request: ApprovalRequest;
  hob: Agent;
  threadTitle: string;
  now: Date;
}) {
  const pending = request.state === "pending";
  const retired = hob.status === "retired";
  const title = requestTitle(request);
  return (
    <article
      key={request.id}
      aria-label={copy.detail.label({ name: hob.name, action: title.what })}
      className="flex max-w-[760px] animate-hb-in flex-col gap-3.5 px-7 py-5"
    >
      <header className="flex flex-col gap-2.5">
        <span className="flex items-center gap-2.5 text-[13px] text-secondary-text">
          <HobSprite hob={hob} size={22} state={pending ? "needs-you" : "idle"} />
          {copy.from({ name: hob.name })}
          <Badge variant={request.state === "expired" ? "muted" : "needs-you"} className="ml-auto">
            {request.state === "expired" ? copy.kind.expired : copy.kind.approval}
          </Badge>
        </span>
        <h2 className="m-0 font-pixel text-[26px] leading-tight font-bold text-moonlight">{title.what}</h2>
      </header>
      <dl className="m-0 grid grid-cols-[120px_1fr] text-sm">
        <Fact term={copy.detail.thread}>{threadTitle}</Fact>
        <Fact term={copy.detail.asked}>{formatWhen(request.createdAt)}</Fact>
        {pending && request.expiresAt !== null && (
          <Fact term={copy.detail.expires}>
            {copy.detail.expiresLead({ expiry: expiryText(request.expiresAt, now), name: hob.name })}
          </Fact>
        )}
        {request.decidedAt !== null && <Fact term={copy.detail.decided}>{formatWhen(request.decidedAt)}</Fact>}
      </dl>
      <ApprovalCard approval={request} hob={hob} />
      {!retired && (
        <div className="flex flex-wrap gap-2.5">
          <Button asChild variant="outline">
            <Link
              to="/hobs/$hobId/threads/$threadId"
              params={{ hobId: request.agentId, threadId: request.threadId }}
              search={{ message: request.messageId }}
            >
              {copy.detail.openChat}
            </Link>
          </Button>
        </div>
      )}
      <p className="m-0 text-xs text-label empty:hidden">{footText(request, hob.name)}</p>
    </article>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="border-b-2 border-line py-2 text-label">{term}</dt>
      <dd className="m-0 border-b-2 border-line py-2">{children}</dd>
    </>
  );
}

/** What the line under the card says: why an expired request cannot be approved, or what deciding covers. */
const footText = (request: ApprovalRequest, name: string): string => {
  if (request.state === "expired") return copy.detail.expiredFoot;
  return request.state === "pending" ? copy.detail.pendingFoot({ name }) : "";
};
