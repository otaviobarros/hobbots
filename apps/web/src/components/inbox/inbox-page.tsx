import type { WaitingDevice, WaitingQuestion } from "@hobbots/api";
import type { ApprovalRequest, BackpackItem, Quest, TaskId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@hobbots/ui/components/empty";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import { inboxQuery } from "../../api/approvals.ts";
import { useBlockersQuery } from "../../api/blockers.ts";
import { usePromptedDevices } from "../../api/pairing.ts";
import { agentsQuery } from "../../api/queries.ts";
import { useWaitingQuestionsQuery } from "../../api/questions.ts";
import { readStored, writeStored } from "../../lib/storage.ts";
import { messages as blockerCopy } from "../blockers/messages.ts";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { PageHeader } from "../shell/pages.tsx";
import { EntryDetail } from "./inbox-detail.tsx";
import {
  entryAsker,
  type InboxEntry,
  namesRequest,
  needsEntries,
  type SoonestExpiry,
  selectedEntry,
  soonestExpiry,
} from "./inbox-entries.ts";
import { InboxHistory } from "./inbox-history.tsx";
import { expiryText, type InboxTab, type InboxView, isInboxView, pendingCount, tabRequests } from "./inbox-items.ts";
import { InboxKeyHints } from "./inbox-key-hints.tsx";
import { shownOrder } from "./inbox-keys.ts";
import { InboxList, InboxViewPicker } from "./inbox-list.tsx";
import { InboxPanel, InboxTabList, InboxTabs } from "./inbox-tabs.tsx";
import { messages } from "./messages.ts";
import { type ShownHold, useWithShown } from "./shown-request.ts";
import { type InboxDirectory, useEntryQuests, useInboxDirectory } from "./use-inbox-directory.ts";
import { useListKeys } from "./use-list-keys.ts";
import { useNow } from "./use-now.ts";

const copy = messages;

const NONE: ReadonlyArray<ApprovalRequest> = [];

const ALL_CLEAR = { title: copy.allClear, hint: copy.allClearHint };

const NO_ITEMS: ReadonlyArray<BackpackItem> = [];
const NO_QUESTIONS: ReadonlyArray<WaitingQuestion> = [];

type BlockersRead = ReturnType<typeof useBlockersQuery>;
type QuestionsRead = ReturnType<typeof useWaitingQuestionsQuery>;
type InboxRead = ReturnType<typeof useQuery<ReadonlyArray<ApprovalRequest>>>;

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
  const listRef = useRef<HTMLUListElement>(null);
  useListKeys(shownOrder(entries, view, questOf), shownKey, listRef);
  useEffect(() => {
    if (shownKey !== undefined && shownKey !== requestId) {
      void navigate({ to: "/inbox", search: { tab, request: shownKey }, replace: true });
    }
  }, [navigate, tab, shownKey, requestId]);

  const soonest = soonestExpiry(entries, directory.hobName, now);
  const needs = tab === "needs";
  const list = needs && empty === undefined;

  return (
    <InboxTabs tab={tab}>
      <PageHeader
        size="bar"
        icon="Inbox"
        title={copy.title}
        intro={headLine(waiting, soonest, now)}
        introClassName={soonest?.urgent === true ? "text-lantern" : undefined}
        actions={<InboxTabList tab={tab} waiting={waiting} />}
      />
      <InboxPanel tab={tab}>
        {list && (
          <NeedsList
            inbox={inbox}
            questions={questions}
            blockers={blockers}
            entries={entries}
            view={view}
            onView={setView}
            questOf={questOf}
            selectedKey={selected?.key}
            directory={directory}
            now={now}
            listRef={listRef}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {needs ? (
            empty !== undefined ? (
              <AllClear />
            ) : (
              <Selected
                entry={selected}
                hold={shown.hold}
                onRetry={shown.retry}
                directory={directory}
                questOf={questOf}
                ready={inbox.isSuccess}
                now={now}
              />
            )
          ) : (
            <>
              {inbox.isPending && <p className="m-0 px-8 py-6 text-sm text-label">{copy.loading}</p>}
              {inbox.isError && <LoadFailed message={copy.failed} onRetry={() => void inbox.refetch()} />}
              {inbox.isSuccess && <InboxHistory requests={requests} directory={directory} />}
            </>
          )}
        </main>
      </InboxPanel>
    </InboxTabs>
  );
}

/** The line under the title: how many wait, with whose answer is due first, or that nothing waits. */
const headLine = (waiting: number, soonest: SoonestExpiry | undefined, now: Date): string => {
  if (waiting === 0) return copy.nothingWaiting;
  if (soonest === undefined) return copy.waiting({ count: waiting });
  return copy.waitingSoon({ count: waiting, expiry: expiryText(soonest.expiresAt, now), name: soonest.name });
};

/**
 * Needs you's list column: what is still being read or failed to read, By quest or By urgency, the
 * entries, and the keys it answers to under them.
 */
function NeedsList({
  inbox,
  questions,
  blockers,
  entries,
  view,
  onView,
  questOf,
  selectedKey,
  directory,
  now,
  listRef,
}: {
  inbox: InboxRead;
  questions: QuestionsRead;
  blockers: BlockersRead;
  entries: ReadonlyArray<InboxEntry>;
  view: InboxView;
  onView: (view: InboxView) => void;
  questOf: (taskId: TaskId) => Quest | undefined;
  selectedKey: string | undefined;
  directory: InboxDirectory;
  now: Date;
  listRef: RefObject<HTMLUListElement | null>;
}) {
  return (
    <aside aria-label={copy.title} className="flex w-95 flex-none flex-col border-e border-line bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {inbox.isPending && <p className="px-3 py-4 text-sm text-label">{copy.loading}</p>}
        {inbox.isError && <LoadFailed message={copy.failed} onRetry={() => void inbox.refetch()} />}
        <ReadState read={questions} loading={copy.question.loading} failed={copy.question.loadFailed} />
        <ReadState read={blockers} loading={blockerCopy.loading} failed={blockerCopy.loadFailed} />
        {entries.length > 0 && <InboxViewPicker view={view} onChange={onView} />}
        <InboxList
          tab="needs"
          view={view}
          entries={entries}
          questOf={questOf}
          selectedKey={selectedKey}
          directory={directory}
          now={now}
          listRef={listRef}
        />
      </div>
      {entries.length > 0 && <InboxKeyHints />}
    </aside>
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
  questOf,
  ready,
  now,
}: {
  entry: InboxEntry | undefined;
  questOf: (taskId: TaskId) => Quest | undefined;
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
  const asker = entryAsker(entry);
  const hob = asker === undefined ? undefined : directory.hob(asker);
  // A request shows once the hob that asked is read, retired hobs included.
  if (entry.kind === "approval" && hob === undefined) {
    return <p className="m-0 px-7 py-6 text-label">{copy.loadingRequest}</p>;
  }
  return <EntryDetail entry={entry} hob={hob} directory={directory} questOf={questOf} now={now} />;
}

/**
 * A read Needs you lists from besides the requests: a line while it is read, and a failure with a
 * way to read it again. A read again that failed keeps what was read before in the list.
 */
function ReadState({ read, loading, failed }: { read: BlockersRead | QuestionsRead; loading: string; failed: string }) {
  if (read.isPending) return <p className="m-0 px-3 pt-4 text-sm text-label">{loading}</p>;
  return read.isError ? <LoadFailed message={failed} onRetry={() => void read.refetch()} /> : null;
}

/**
 * Needs you with nothing waiting, across the whole page: a hob resting on its ground with a word
 * bubble, then the title and the way to History and Home. The chief stands in before any hob exists.
 */
function AllClear() {
  const hob = useQuery(agentsQuery).data?.[0];
  return (
    <Empty size="page" className="animate-hb-in">
      <EmptyMedia>
        <div
          aria-hidden
          className="relative flex h-37.5 w-110 max-w-full items-end justify-center overflow-hidden rounded-card bg-panel"
        >
          <span className="absolute inset-x-0 bottom-0 h-3 border-t-2 border-line-2 bg-line" />
          <span className="relative mb-3">
            {hob === undefined ? <ChiefMark size={72} /> : <HobSprite hob={hob} size={72} />}
          </span>
          <span className="absolute start-[calc(50%+44px)] top-6.5 rounded-[12px_12px_12px_2px] bg-card px-3 py-1.75 text-sm whitespace-nowrap text-text-strong shadow-menu">
            {copy.allQuiet}
          </span>
        </div>
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{copy.allClear}</EmptyTitle>
        <EmptyDescription>{copy.allClearHint}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button asChild variant="outline">
          <Link to="/inbox" search={{ tab: "history" }}>
            {copy.seeDecided}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/">{copy.backHome}</Link>
        </Button>
      </EmptyContent>
    </Empty>
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
