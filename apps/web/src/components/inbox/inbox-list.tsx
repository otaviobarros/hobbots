import type { ApprovalRequest } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { cn } from "@hobbots/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { HobSprite } from "../hob-sprite.tsx";
import { groupByThread, INBOX_TABS, type InboxTab, requestTitle, statusText } from "./inbox-items.ts";
import { messages } from "./messages.ts";
import type { InboxDirectory } from "./use-inbox-directory.ts";

const copy = messages;

/** Needs you, All and History, with how many requests need you on the first. The tab is in the address. */
export function InboxTabs({ tab, waiting }: { tab: InboxTab; waiting: number }) {
  const navigate = useNavigate();
  return (
    <div role="tablist" aria-label={copy.tabsLabel} className="flex gap-0.5 border-b-2 border-line px-2.5 pt-2">
      {INBOX_TABS.map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={tab === name}
          onClick={() => void navigate({ to: "/inbox", search: { tab: name } })}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 border-0 px-3 py-2 text-[13px] font-bold",
            tab === name
              ? "bg-hover text-moonlight shadow-[inset_0_-3px_0_var(--color-lantern)]"
              : "bg-transparent text-secondary-text hover:bg-hover hover:text-text",
          )}
        >
          {copy.tabs[name]}
          {name === "needs" && waiting > 0 && <Badge variant="needs-you">{waiting}</Badge>}
        </button>
      ))}
    </div>
  );
}

/** The tab's requests, grouped by hob and thread; the selected one is filled. */
export function InboxList({
  tab,
  requests,
  selectedId,
  directory,
  now,
}: {
  tab: InboxTab;
  requests: ReadonlyArray<ApprovalRequest>;
  selectedId: string | undefined;
  directory: InboxDirectory;
  now: Date;
}) {
  return (
    <ul aria-label={copy.listLabel} className="m-0 flex list-none flex-col p-0 py-1">
      {groupByThread(requests).map((group) => {
        const first = group.requests[0];
        if (first === undefined) return null;
        return (
          <li key={group.threadId} className="flex flex-col">
            <span className="lbl px-3 pt-2.5 pb-1 text-xs text-label">
              {copy.group({ name: directory.hobName(first.agentId), thread: directory.threadTitle(group.threadId) })}
            </span>
            <ul className="m-0 flex list-none flex-col p-0">
              {group.requests.map((request) => (
                <li key={request.id}>
                  <InboxItem
                    tab={tab}
                    request={request}
                    selected={request.id === selectedId}
                    directory={directory}
                    now={now}
                  />
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function InboxItem({
  tab,
  request,
  selected,
  directory,
  now,
}: {
  tab: InboxTab;
  request: ApprovalRequest;
  selected: boolean;
  directory: InboxDirectory;
  now: Date;
}) {
  const hob = directory.hob(request.agentId);
  const pending = request.state === "pending";
  const expired = request.state === "expired";
  const title = requestTitle(request);
  return (
    <Link
      to="/inbox"
      search={{ tab, request: request.id }}
      aria-current={selected ? "page" : undefined}
      activeOptions={{ exact: true, includeSearch: true }}
      data-state={request.state}
      className={cn(
        "hop-on-hover flex w-full items-start gap-2.5 px-2.5 py-2.5 text-left text-text no-underline hover:text-text",
        selected ? "bg-line" : "hover:bg-hover",
        !pending && "opacity-70",
      )}
    >
      {hob && <HobSprite hob={hob} size={26} state={pending ? "needs-you" : "idle"} className="mt-0.5" />}
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-center gap-2">
          <span className="flex-1 text-[13px] text-secondary-text">
            {copy.from({ name: directory.hobName(request.agentId) })}
          </span>
          <Badge variant={expired ? "muted" : "needs-you"}>{expired ? copy.kind.expired : copy.kind.approval}</Badge>
        </span>
        <span className="text-sm leading-snug">{title.what}</span>
        <code className="truncate font-mono text-xs text-moonlight">{title.exact}</code>
        <span className={cn("text-xs", pending ? "text-lantern" : "text-label")}>{statusText(request, now)}</span>
      </span>
    </Link>
  );
}
