import type { ApprovalRequest } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { inboxQuery } from "../../api/approvals.ts";
import { Stars } from "../scene.tsx";
import { InboxDetail } from "./inbox-detail.tsx";
import { Empty, InboxHistory } from "./inbox-history.tsx";
import { type InboxTab, pendingCount, selectedRequest, tabRequests } from "./inbox-items.ts";
import { InboxList, InboxTabs } from "./inbox-list.tsx";
import { messages } from "./messages.ts";
import { type ShownHold, useWithShown } from "./shown-request.ts";
import { type InboxDirectory, useInboxDirectory } from "./use-inbox-directory.ts";
import { useNow } from "./use-now.ts";

const copy = messages;

const NONE: ReadonlyArray<ApprovalRequest> = [];

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
  const shown = useWithShown(inbox.data ?? NONE, requestId, inbox.isSuccess);
  const approvals = shown.approvals;
  const directory = useInboxDirectory(approvals);
  const requests = tabRequests(approvals, tab, requestId);
  const selected = tab === "history" || shown.hold !== undefined ? undefined : selectedRequest(requests, requestId);
  const waiting = pendingCount(approvals);
  const now = useNow();
  const navigate = useNavigate();
  // The request shown goes into the address as soon as it shows, so it stays in view while it is
  // decided here or elsewhere, and a click never lands on a request that took its place.
  const shownId = selected?.id;
  useEffect(() => {
    if (shownId !== undefined && shownId !== requestId) {
      void navigate({ to: "/inbox", search: { tab, request: shownId }, replace: true });
    }
  }, [navigate, tab, shownId, requestId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label={copy.title} className="flex w-95 flex-none flex-col border-e-4 border-line bg-panel">
        <InboxHeader waiting={waiting} />
        <InboxTabs tab={tab} waiting={waiting} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {inbox.isPending && <p className="px-3 py-4 text-sm text-label">{copy.loading}</p>}
          {inbox.isError && <LoadFailed message={copy.failed} onRetry={() => void inbox.refetch()} />}
          {inbox.isSuccess && tab !== "history" && requests.length === 0 && <Empty {...EMPTY[tab]} />}
          {tab !== "history" && (
            <InboxList tab={tab} requests={requests} selectedId={selected?.id} directory={directory} now={now} />
          )}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {tab === "history" ? (
          inbox.isSuccess && <InboxHistory requests={requests} directory={directory} />
        ) : (
          <Selected
            request={selected}
            hold={shown.hold}
            onRetry={shown.retry}
            directory={directory}
            ready={inbox.isSuccess}
            now={now}
          />
        )}
      </main>
    </div>
  );
}

function Selected({
  request,
  hold,
  onRetry,
  directory,
  ready,
  now,
}: {
  request: ApprovalRequest | undefined;
  hold: ShownHold | undefined;
  onRetry: () => void;
  directory: InboxDirectory;
  ready: boolean;
  now: Date;
}) {
  if (hold === "loading") return <p className="m-0 px-7 py-6 text-label">{copy.loadingRequest}</p>;
  if (hold === "failed") {
    return (
      <div className="px-7 py-6">
        <LoadFailed message={copy.requestFailed} onRetry={onRetry} />
      </div>
    );
  }
  if (request === undefined) {
    return ready ? <p className="m-0 px-7 py-6 text-secondary-text">{copy.pickOne}</p> : null;
  }
  const hob = directory.hob(request.agentId);
  if (hob === undefined) return <p className="m-0 px-7 py-6 text-label">{copy.loadingRequest}</p>;
  return <InboxDetail request={request} hob={hob} threadTitle={directory.threadTitle(request.threadId)} now={now} />;
}

/** The mailbox at the top of the list; its flag goes up and pulses while requests wait. */
function InboxHeader({ waiting }: { waiting: number }) {
  return (
    <div className="relative h-23 flex-none overflow-hidden border-b-2 border-line bg-deep">
      <Stars count={8} height={40} />
      <span aria-hidden className="absolute inset-x-5.5 bottom-0 h-2.5 bg-line" />
      <span aria-hidden className="absolute bottom-2.5 start-42.5 h-7.5 w-10 bg-wood" />
      <span aria-hidden className="absolute bottom-7.5 start-44 h-1 w-7 bg-ground" />
      <span aria-hidden className="absolute bottom-0 start-46.5 h-2.5 w-2 bg-wood" />
      <span
        aria-hidden
        className={cn(
          "absolute bottom-7.5 start-52.5 h-4.5 w-1 origin-bottom bg-rose",
          waiting > 0 ? "animate-hb-blink" : "rotate-90",
        )}
      />
      <h1 className="absolute top-2.5 start-4 m-0 font-pixel text-xl font-bold text-moonlight">{copy.title}</h1>
      <p className="absolute top-9 start-4 m-0 text-xs text-secondary-text">
        {waiting > 0 ? copy.waiting({ count: waiting }) : copy.intro}
      </p>
    </div>
  );
}

function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 px-3 py-4 text-sm text-rose">
      {message}
      <Button variant="outline" onClick={onRetry}>
        {copy.retry}
      </Button>
    </div>
  );
}
