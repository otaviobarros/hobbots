import type { ApprovalRequest } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { formatWhen } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { requestTitle, verdictText } from "./inbox-items.ts";
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
    <section aria-label={copy.history.heading} className="flex max-w-215 flex-col gap-3 px-7 py-5.5">
      <span className="lbl text-xs text-label">{copy.history.heading}</span>
      <h2 className="m-0 font-pixel text-2xl font-bold text-moonlight">{copy.history.title}</h2>
      <p className="m-0 text-sm text-secondary-text">{copy.history.intro}</p>
      {requests.length === 0 ? (
        <Empty title={copy.emptyHistory} hint={copy.emptyHistoryHint} />
      ) : (
        <ul className="cut m-0 flex list-none flex-col bg-panel px-4 py-1">
          {requests.map((request) => {
            const hob = directory.hob(request.agentId);
            const title = requestTitle(request);
            return (
              <li
                key={request.id}
                data-state={request.state}
                className="flex items-center gap-3 border-b-2 border-line py-2.75 last:border-b-0"
              >
                <Badge variant={VERDICT[request.state]} className="w-21.5 justify-center">
                  {verdictText(request)}
                </Badge>
                {hob && <HobSprite hob={hob} size={22} />}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm">
                    {copy.history.action({ name: directory.hobName(request.agentId), action: title.what })}
                  </span>
                  <code className="truncate font-mono text-xs text-moonlight">{title.exact}</code>
                  <span className="text-xs text-label">
                    {copy.history.meta({
                      when: formatWhen(request.decidedAt ?? request.createdAt),
                      thread: directory.threadTitle(request.threadId),
                    })}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What an empty tab says. */
export function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
      <span className="font-pixel text-lg font-bold text-moonlight">{title}</span>
      <span className="text-sm text-secondary-text">{hint}</span>
    </div>
  );
}
