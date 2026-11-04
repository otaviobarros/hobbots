import type { WaitingDevice, WaitingQuestion } from "@hobbots/api";
import type { ApprovalRequest, BackpackItem } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockersQuery } from "../../api/blockers.ts";
import { usePromptedDevices } from "../../api/pairing.ts";
import { useWaitingQuestionsQuery } from "../../api/questions.ts";
import { readStored, writeStored } from "../../lib/storage.ts";
import { messages as blockerCopy } from "../blockers/messages.ts";
import { Stars } from "../scene.tsx";
import { EntryDetail, InboxDetail } from "./inbox-detail.tsx";
import { type InboxEntry, namesRequest, needsEntries, selectedEntry } from "./inbox-entries.ts";
import { Empty, InboxHistory } from "./inbox-history.tsx";
import { type InboxTab, type InboxView, isInboxView, pendingCount, tabRequests } from "./inbox-items.ts";
import { InboxList, InboxTabs, InboxViewPicker } from "./inbox-list.tsx";
import { messages } from "./messages.ts";
import { type ShownHold, useWithShown } from "./shown-request.ts";
import { type InboxDirectory, useEntryQuests, useInboxDirectory } from "./use-inbox-directory.ts";
import { useNow } from "./use-now.ts";

const copy = messages;

const NONE: ReadonlyArray<ApprovalRequest> = [];

const ALL_CLEAR = { title: copy.allClear, hint: copy.allClearHint };

const NO_ITEMS: ReadonlyArray<BackpackItem> = [];
const NO_QUESTIONS: ReadonlyArray<WaitingQuestion> = [];

type BlockersRead = ReturnType<typeof useBlockersQuery>;
type QuestionsRead = ReturnType<typeof useWaitingQuestionsQuery>;

/** How many things wait for you: pending requests, questions for you and stuck work. */
const waitingCount = (approvals: ReadonlyArray<ApprovalRequest>, blockers: BlockersRead, questions: QuestionsRead) =>
  pendingCount(approvals) + (blockers.data ?? NO_ITEMS).length + (questions.data ?? NO_QUESTIONS).length;

/** Whether a read has finished and holds nothing. */
const readEmpty = (read: { readonly isSuccess: boolean; readonly data?: ReadonlyArray<unknown> | undefined }) =>
  read.isSuccess && read.data?.length === 0;

/**
 * What an empty tab says once it lists nothing. Needs you waits for every read: while one loads,
 * or after it failed, it never says nothing waits. History says nothing here.
 */
const emptyState = (
  tab: InboxTab,
  read: boolean,
  entries: ReadonlyArray<InboxEntry>,
  blockers: BlockersRead,
  questions: QuestionsRead,
) => {
  if (tab === "history" || !read || entries.length > 0) return undefined;
  if (!(readEmpty(blockers) && readEmpty(questions))) return undefined;
  return ALL_CLEAR;
};

/** Everything the Inbox reads, and what the open tab lists and shows from it. */
const useInbox = (tab: InboxTab, requestId: string | undefined) => {
  const inbox = useQuery(inboxQuery);
  const shown = useWithShown(
    inbox.data ?? NONE,
    requestId !== undefined && namesRequest(requestId) ? requestId : undefined,
    inbox.isSuccess,
  );
  const approvals = shown.approvals;
  const directory = useInboxDirectory(approvals);
  const requests = tabRequests(approvals, tab, requestId);
  const blockers = useBlockersQuery();
  const questions = useWaitingQuestionsQuery();
  const devices = usePromptedDevices();
  const entries = tabEntries(tab, requests, devices, questions.data ?? NO_QUESTIONS, blockers.data ?? NO_ITEMS);
  const questOf = useEntryQuests(entries);
  return {
    questOf,
    inbox,
    shown,
    directory,
    requests,
    blockers,
    questions,
    entries,
    selected: tab === "history" || shown.hold !== undefined ? undefined : selectedEntry(entries, requestId),
    waiting: waitingCount(approvals, blockers, questions) + devices.length,
    empty: emptyState(tab, inbox.isSuccess, entries, blockers, questions),
  };
};

/**
 * The Inbox (screen 8): everything that waits on you in one list, every kind as the same row: the
 * requests from every hob, questions no lead could answer, stuck work and devices asking to pair.
 * Needs you, All and History, and beside the list the selected entry in full with the controls the
 * chat has. It follows the journal, so an entry decided in the chat updates here, and the reverse.
 */
export function InboxPage({ tab, requestId }: { tab: InboxTab; requestId: string | undefined }) {
  const { inbox, shown, directory, requests, blockers, questions, entries, questOf, selected, waiting, empty } =
    useInbox(tab, requestId);
  const [view, setView] = useInboxView();
  const now = useNow();
  const navigate = useNavigate();
  // The entry shown goes into the address as soon as it shows, so it stays in view while it is
  // decided here or elsewhere, and a click never lands on an entry that took its place.
  const shownKey = selected?.key;
  useEffect(() => {
    if (shownKey !== undefined && shownKey !== requestId) {
      void navigate({ to: "/inbox", search: { tab, request: shownKey }, replace: true });
    }
  }, [navigate, tab, shownKey, requestId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label={copy.title} className="flex w-95 flex-none flex-col border-e-4 border-line bg-panel">
        <InboxHeader waiting={waiting} />
        <InboxTabs tab={tab} waiting={waiting}>
          {inbox.isPending && <p className="px-3 py-4 text-sm text-label">{copy.loading}</p>}
          {inbox.isError && <LoadFailed message={copy.failed} onRetry={() => void inbox.refetch()} />}
          {tab === "needs" && (
            <ReadState read={questions} loading={copy.question.loading} failed={copy.question.loadFailed} />
          )}
          {tab === "needs" && (
            <ReadState read={blockers} loading={blockerCopy.loading} failed={blockerCopy.loadFailed} />
          )}
          {empty !== undefined && <Empty {...empty} />}
          {tab === "needs" && entries.length > 0 && <InboxViewPicker view={view} onChange={setView} />}
          {tab !== "history" && (
            <InboxList
              tab={tab}
              view={view}
              entries={entries}
              questOf={questOf}
              selectedKey={selected?.key}
              directory={directory}
              now={now}
            />
          )}
        </InboxTabs>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {tab === "history" ? (
          inbox.isSuccess && <InboxHistory requests={requests} directory={directory} />
        ) : (
          <Selected
            entry={selected}
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

const VIEW_KEY = "inbox.view";

/** By quest or By urgency, remembered on this device. */
const useInboxView = () => {
  const [view, setView] = useState<InboxView>(() => {
    const stored = readStored<unknown>(VIEW_KEY, "quest");
    return isInboxView(stored) ? stored : "quest";
  });
  const choose = (next: InboxView) => {
    setView(next);
    writeStored(VIEW_KEY, next);
  };
  return [view, choose] as const;
};

/** The tab's entries: everything waiting in Needs you, and none in History, which lists decisions. */
const tabEntries = (
  tab: InboxTab,
  requests: ReadonlyArray<ApprovalRequest>,
  devices: ReadonlyArray<WaitingDevice>,
  questions: ReadonlyArray<WaitingQuestion>,
  blockers: ReadonlyArray<BackpackItem>,
): ReadonlyArray<InboxEntry> => {
  return tab === "needs" ? needsEntries({ devices, questions, blockers, requests }) : [];
};

function Selected({
  entry,
  hold,
  onRetry,
  directory,
  ready,
  now,
}: {
  entry: InboxEntry | undefined;
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
  if (entry === undefined) {
    return ready ? <p className="m-0 px-7 py-6 text-text-secondary">{copy.pickOne}</p> : null;
  }
  if (entry.kind !== "approval") return <EntryDetail entry={entry} now={now} />;
  const request = entry.request;
  const hob = directory.hob(request.agentId);
  if (hob === undefined) return <p className="m-0 px-7 py-6 text-label">{copy.loadingRequest}</p>;
  return (
    <InboxDetail
      request={request}
      hob={hob}
      threadTitle={directory.threadTitle(request.threadId)}
      threadHob={directory.threadHob(request.threadId)}
      now={now}
    />
  );
}

/**
 * A read Needs you lists from besides the requests: a line while it is read, and a failure with a
 * way to read it again. A read again that failed keeps what was read before in the list.
 */
function ReadState({ read, loading, failed }: { read: BlockersRead | QuestionsRead; loading: string; failed: string }) {
  if (read.isPending) return <p className="m-0 px-3 pt-4 text-sm text-label">{loading}</p>;
  return read.isError ? <LoadFailed message={failed} onRetry={() => void read.refetch()} /> : null;
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
      <h1 className="absolute top-2.5 start-4 m-0 font-heading text-xl font-bold text-moonlight">{copy.title}</h1>
      <p className="absolute top-9 start-4 m-0 text-xs text-text-secondary">
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
