import type { ApprovalRequest } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { inboxQuery } from "../../api/approvals.ts";
import { Stars } from "../scene.tsx";
import { InboxDetail } from "./inbox-detail.tsx";
import { Empty, InboxHistory } from "./inbox-history.tsx";
import { type InboxTab, pendingCount, selectedRequest, tabRequests } from "./inbox-items.ts";
import { InboxList, InboxTabs } from "./inbox-list.tsx";
import { messages } from "./messages.ts";
import { type InboxDirectory, useInboxDirectory } from "./use-inbox-directory.ts";

const copy = messages;

const EMPTY: Record<Exclude<InboxTab, "history">, { readonly title: string; readonly hint: string }> = {
  needs: { title: copy.allClear, hint: copy.allClearHint },
  all: { title: copy.emptyAll, hint: copy.emptyAllHint },
};

/**
 * The Inbox (screen 8): every approval request from every hob in one place, grouped by hob and
 * thread until Quests exist. Needs you, All and History, and beside the list the selected request
 * in full with the chat's own decision controls. It follows the journal, so a request decided in
 * the chat updates here, and the reverse.
 */
export function InboxPage({ tab, requestId }: { tab: InboxTab; requestId: string | undefined }) {
  const inbox = useQuery(inboxQuery);
  const approvals = inbox.data ?? [];
  const directory = useInboxDirectory(approvals);
  const requests = tabRequests(approvals, tab, requestId);
  const selected = tab === "history" ? undefined : selectedRequest(requests, requestId);
  const waiting = pendingCount(approvals);
  const navigate = useNavigate();
  // Using the request shown first puts it in the address, so deciding it keeps it in view.
  const pin = () => {
    if (selected !== undefined && selected.id !== requestId) {
      void navigate({ to: "/inbox", search: { tab, request: selected.id }, replace: true });
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label={copy.title} className="flex w-[380px] flex-none flex-col border-r-4 border-line bg-panel">
        <InboxHeader waiting={waiting} />
        <InboxTabs tab={tab} waiting={waiting} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {inbox.isPending && <p className="px-3 py-4 text-sm text-label">{copy.loading}</p>}
          {inbox.isError && <LoadFailed onRetry={() => void inbox.refetch()} />}
          {inbox.isSuccess && tab !== "history" && requests.length === 0 && <Empty {...EMPTY[tab]} />}
          {tab !== "history" && (
            <InboxList tab={tab} requests={requests} selectedId={selected?.id} directory={directory} />
          )}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto" onFocus={pin}>
        {tab === "history" ? (
          inbox.isSuccess && <InboxHistory requests={requests} directory={directory} />
        ) : (
          <Selected request={selected} directory={directory} ready={inbox.isSuccess} />
        )}
      </main>
    </div>
  );
}

function Selected({
  request,
  directory,
  ready,
}: {
  request: ApprovalRequest | undefined;
  directory: InboxDirectory;
  ready: boolean;
}) {
  if (request === undefined) {
    return ready ? <p className="m-0 px-7 py-6 text-secondary-text">{copy.pickOne}</p> : null;
  }
  const hob = directory.hob(request.agentId);
  if (hob === undefined) return null;
  return <InboxDetail request={request} hob={hob} threadTitle={directory.threadTitle(request.threadId)} />;
}

/** The mailbox at the top of the list; its flag goes up and pulses while requests wait. */
function InboxHeader({ waiting }: { waiting: number }) {
  return (
    <div className="relative h-[92px] flex-none overflow-hidden border-b-2 border-line bg-deep">
      <Stars count={8} height={40} />
      <span aria-hidden className="absolute inset-x-[22px] bottom-0 h-2.5 bg-line" />
      <span aria-hidden className="absolute bottom-2.5 left-[170px] h-[30px] w-10 bg-wood" />
      <span aria-hidden className="absolute bottom-[30px] left-[176px] h-1 w-7 bg-ground" />
      <span aria-hidden className="absolute bottom-0 left-[186px] h-2.5 w-2 bg-wood" />
      <span
        aria-hidden
        className={cn(
          "absolute bottom-[30px] left-[210px] h-[18px] w-1 origin-bottom bg-rose",
          waiting > 0 ? "animate-hb-blink" : "rotate-90",
        )}
      />
      <h1 className="absolute top-2.5 left-4 m-0 font-pixel text-xl font-bold text-moonlight">{copy.title}</h1>
      <p className="absolute top-9 left-4 m-0 text-xs text-secondary-text">
        {waiting > 0 ? copy.waiting({ count: waiting }) : copy.intro}
      </p>
    </div>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 px-3 py-4 text-sm text-rose">
      {copy.failed}
      <Button variant="outline" onClick={onRetry}>
        {copy.retry}
      </Button>
    </div>
  );
}
