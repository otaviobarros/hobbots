import type { ApprovalRequest } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { formatWhen } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { StandingRules } from "../standing-rules/standing-rules.tsx";
import { deciderText, requestTitle, verdictText } from "./inbox-items.ts";
import { messages } from "./messages.ts";
import type { InboxDirectory } from "./use-inbox-directory.ts";

const copy = messages;

const VERDICT: Record<ApprovalRequest["state"], "done" | "failed" | "muted"> = {
  approved: "done",
  denied: "failed",
  expired: "muted",
  pending: "muted",
};

/** Every decided and expired request, newest first, with who asked, when and in which thread. */
export function InboxHistory({
  requests,
  directory,
}: {
  requests: ReadonlyArray<ApprovalRequest>;
  directory: InboxDirectory;
}) {
  return (
    <div className="flex max-w-205 flex-col gap-7 px-8 pt-6 pb-8">
      <StandingRules />
      <section aria-label={copy.history.heading} className="flex flex-col gap-2.5">
        <h2 className="m-0 flex items-center gap-2 text-ui font-semibold text-text-strong">
          {copy.history.title}
          <span className="text-meta font-normal text-label">{copy.count({ count: requests.length })}</span>
        </h2>
        <p className="m-0 text-ui text-text-secondary">{copy.history.intro}</p>
        {requests.length === 0 ? (
          <Empty title={copy.emptyHistory} hint={copy.emptyHistoryHint} />
        ) : (
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-card bg-card p-0">
            {requests.map((request) => (
              <HistoryRow key={request.id} request={request} directory={directory} />
            ))}
          </ul>
        )}
        <p className="m-0 text-detail text-label">{copy.history.expiredNote}</p>
      </section>
    </div>
  );
}

/** One decision: the verdict, who asked and what, when and where, who decided, and the exact action. */
function HistoryRow({ request, directory }: { request: ApprovalRequest; directory: InboxDirectory }) {
  const hob = directory.hob(request.agentId);
  const title = requestTitle(request);
  const decider = deciderText(request, directory.deviceName);
  return (
    <li data-state={request.state} className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <Badge variant={VERDICT[request.state]} className="w-18 justify-center">
        {verdictText(request)}
      </Badge>
      {hob && <HobSprite hob={hob} size={22} />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui text-text-strong">
          {copy.history.action({ name: directory.hobName(request.agentId), action: title.what })}
        </span>
        <span className="truncate text-meta text-label">
          {copy.history.meta({
            when: formatWhen(request.decidedAt ?? request.createdAt),
            thread: directory.threadTitle(request.threadId),
          })}
        </span>
        {decider !== null && (
          <span data-testid="decider" className="text-meta text-text-secondary">
            {decider}
          </span>
        )}
      </span>
      <code className="max-w-60 shrink truncate rounded-tag bg-deep px-1.5 py-0.5 font-mono text-code text-moonlight">
        {title.exact}
      </code>
    </li>
  );
}

/** What an empty tab says. */
function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
      <span className="font-heading text-title font-bold text-moonlight">{title}</span>
      <span className="text-ui text-text-secondary">{hint}</span>
    </div>
  );
}
