import type { Agent, AgentId, Thread, ThreadId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  agentsQuery,
  archivedAgentsQuery,
  archivedThreadsQuery,
  messagesQuery,
  threadsQuery,
} from "../../api/queries.ts";
import { formatDay, formatWhen } from "../../lib/time.ts";
import { MessageRow } from "../chat/message-row.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { useArchiveActions } from "./archive-notices.tsx";
import {
  ArchiveFrame,
  ArchiveNote,
  BoxIcon,
  type Crumb,
  Crumbs,
  DimPortrait,
  doorStyle,
  LockIcon,
  MoonIcon,
  RestoreIcon,
  stripStyle,
} from "./archive-parts.tsx";
import { messages } from "./messages.ts";

const copy = messages;
const archiveCrumb: Crumb = { label: copy.title, to: "/archive", search: {} };
const retiredCrumb: Crumb = { label: copy.tabs.hobs, to: "/archive", search: { tab: "hobs" } };

/**
 * An archived chat, read-only: its title, a note that says when it was archived, the transcript and
 * a bar that stays at the bottom with Restore to the hob's chats. Restoring goes back to the list.
 */
export function ArchivedChatPage({ hobId, threadId }: { hobId: AgentId; threadId: ThreadId }) {
  const navigate = useNavigate();
  const actions = useArchiveActions();
  const hob = useQuery({ ...agentsQuery, select: (hobs) => hobs.find((h) => h.id === hobId) });
  const archived = useQuery({ ...archivedThreadsQuery(hobId), select: (list) => list.find((t) => t.id === threadId) });
  const live = useQuery({ ...threadsQuery(hobId), select: (list) => list.some((t) => t.id === threadId) });
  const thread = archived.data;

  if (hob.isError || archived.isError) return <Problem crumb={archiveCrumb} text={copy.read.loadFailed} />;
  if (hob.isPending || archived.isPending) return <Problem crumb={archiveCrumb} text={copy.read.loading} pending />;
  if (!hob.data || !thread) {
    return (
      <Problem crumb={archiveCrumb} text={live.data ? copy.read.notArchived : copy.read.missing}>
        {hob.data && live.data ? (
          <Link to="/hobs/$hobId/threads/$threadId" params={{ hobId, threadId }} className="text-link underline">
            {copy.read.openIt}
          </Link>
        ) : (
          <Link to="/archive" className="text-link underline">
            {copy.read.backToArchive}
          </Link>
        )}
      </Problem>
    );
  }
  const current = hob.data;
  const day = formatDay(thread.archivedAt ?? thread.updatedAt);
  const busy = actions.busy(thread);

  return (
    <ArchiveFrame label={thread.title} wide={false}>
      <Crumbs trail={[archiveCrumb]} current={thread.title} />
      <ReadHeader hob={current} title={thread.title} meta={copy.read.withHob({ name: current.name, day })} />
      <ArchiveNote icon={<BoxIcon />}>{copy.read.banner({ name: current.name, day })}</ArchiveNote>
      <Transcript hob={current} threadId={thread.id} />
      <ReadOnlyBar text={copy.read.bar}>
        <Button
          disabled={busy}
          className="min-w-0 max-w-[280px] flex-shrink"
          onClick={() =>
            actions.restore(current, thread, () => void navigate({ to: "/archive", search: { hob: current.id } }))
          }
        >
          <RestoreIcon />
          <span className="truncate">{busy ? copy.chats.restoring : copy.read.restoreTo({ name: current.name })}</span>
        </Button>
      </ReadOnlyBar>
    </ArchiveFrame>
  );
}

/** A retired hob's own page in the Archive: its hero on gray ground, a note and its chats, read-only. */
export function RetiredHobPage({ hobId }: { hobId: AgentId }) {
  const found = useRetired(hobId);
  if (found.kind !== "found") return <Problem crumb={retiredCrumb} {...found} />;
  const { hob, chats } = found;
  const retired = hob.retiredAt ? formatDay(hob.retiredAt) : null;

  return (
    <ArchiveFrame label={copy.retired.page({ name: hob.name })}>
      <Crumbs trail={[retiredCrumb]} current={hob.name} />
      <section aria-label={hob.name} className="cut relative overflow-hidden px-6 pt-6" style={doorStyle}>
        <div className="relative flex flex-wrap items-end gap-5">
          <span className="flex h-[104px] w-24 flex-none items-end justify-center">
            <HobSprite hob={hob} size={86} state="asleep" className="mb-1.5 opacity-65 grayscale-85" />
          </span>
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1.5 pb-[18px]">
            <span className="flex min-w-0 items-center gap-2.5">
              <h1
                title={hob.name}
                className="m-0 min-w-0 truncate font-(family-name:--font-heading) text-[32px] leading-[38px] font-(--heading-weight) [font-variant-ligatures:none]"
              >
                {hob.name}
              </h1>
              <Badge variant="resting">
                <MoonIcon />
                {copy.hobs.tag}
              </Badge>
            </span>
            <span className="truncate text-[15px] text-text-secondary">
              {copy.retired.line({ role: hob.roleTitle, day: retired, kept: copy.hobs.kept({ count: chats.length }) })}
            </span>
          </div>
          <div className="flex flex-none items-center pb-[18px]">
            <BringBackButton hob={hob} chats={chats.length} />
          </div>
        </div>
        <div aria-hidden className="relative -mx-6 h-2.5" style={stripStyle} />
      </section>
      <ArchiveNote icon={<MoonIcon />}>{copy.retired.note({ name: hob.name })}</ArchiveNote>
      {chats.length === 0 ? (
        <p className="m-0 text-sm text-text-secondary">{copy.retired.none({ name: hob.name })}</p>
      ) : (
        <ul aria-label={copy.retired.chats({ name: hob.name })} className="cut m-0 flex list-none flex-col bg-card p-0">
          {chats.map((thread) => (
            <li key={thread.id} className="border-b border-line last:border-b-0">
              <Link
                to="/archive/hobs/$hobId/$threadId"
                params={{ hobId: hob.id, threadId: thread.id }}
                aria-label={copy.retired.open({ title: thread.title })}
                className="flex items-center gap-3 px-3.5 py-3 text-text-strong no-underline hover:bg-hover hover:text-text-strong"
              >
                <span title={thread.title} className="min-w-0 flex-1 truncate font-semibold">
                  {thread.title}
                </span>
                <span className="flex flex-none items-center gap-1.5 text-xs text-label">
                  {formatWhen(thread.updatedAt)}
                  <LockIcon label={copy.retired.readOnly} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ArchiveFrame>
  );
}

/** One of a retired hob's chats, read-only. */
export function RetiredChatPage({ hobId, threadId }: { hobId: AgentId; threadId: ThreadId }) {
  const found = useRetired(hobId);
  if (found.kind !== "found") return <Problem crumb={retiredCrumb} {...found} />;
  const { hob, chats } = found;
  const hobCrumb: Crumb = { label: hob.name, to: "/archive/hobs/$hobId", params: { hobId: hob.id } };
  const thread = chats.find((t) => t.id === threadId);
  // Messages load by thread id alone, so another hob's chat must not show under this hob.
  if (!thread) return <Problem crumb={hobCrumb} text={copy.retired.notTheirs({ name: hob.name })} />;

  return (
    <ArchiveFrame label={thread.title} wide={false}>
      <Crumbs trail={[retiredCrumb, hobCrumb]} current={thread.title} />
      <ReadHeader
        hob={hob}
        title={thread.title}
        meta={copy.retired.line({
          role: hob.roleTitle,
          day: hob.retiredAt ? formatDay(hob.retiredAt) : null,
          kept: formatWhen(thread.updatedAt),
        })}
      />
      <ArchiveNote icon={<MoonIcon />}>{copy.retired.chatNote({ name: hob.name })}</ArchiveNote>
      <Transcript hob={hob} threadId={thread.id} />
      <ReadOnlyBar text={copy.retired.bar({ name: hob.name })}>
        <BringBackButton hob={hob} chats={chats.length} />
      </ReadOnlyBar>
    </ArchiveFrame>
  );
}

/**
 * Bring back for a retired hob. On a card it is a quiet button; on the hob's own pages it is the
 * main action and goes back to Retired hobs, where the toast offers Undo.
 */
export function BringBackButton({ hob, chats, quiet = false }: { hob: Agent; chats: number; quiet?: boolean }) {
  const navigate = useNavigate();
  const actions = useArchiveActions();
  const busy = actions.hobBusy(hob.id);
  return (
    <Button
      variant={quiet ? "outline" : "default"}
      size={quiet ? "sm" : "default"}
      disabled={busy}
      aria-label={copy.hobs.bringBackLabel({ name: hob.name })}
      className={quiet ? "relative z-[1] flex-none" : "min-w-0 max-w-[260px]"}
      onClick={() =>
        actions.bringBack(
          hob,
          chats,
          quiet ? undefined : () => void navigate({ to: "/archive", search: { tab: "hobs" } }),
        )
      }
    >
      <RestoreIcon />
      <span className="truncate">{busy ? copy.hobs.bringingBack : copy.hobs.bringBack}</span>
    </Button>
  );
}

type Retired =
  | { readonly kind: "found"; readonly hob: Agent; readonly chats: ReadonlyArray<Thread> }
  | { readonly kind: "problem"; readonly text: string; readonly pending?: boolean };

/** A retired hob and all its chats, archived ones too, newest first; or why there is none to show. */
const useRetired = (hobId: AgentId): Retired => {
  const hob = useQuery({ ...archivedAgentsQuery, select: (hobs) => hobs.find((h) => h.id === hobId) });
  const live = useQuery(threadsQuery(hobId));
  const archived = useQuery(archivedThreadsQuery(hobId));
  if (hob.isError || live.isError || archived.isError) return { kind: "problem", text: copy.retired.loadFailed };
  if (hob.isPending) return { kind: "problem", text: copy.retired.loading, pending: true };
  if (!hob.data) return { kind: "problem", text: copy.retired.notHere };
  if (live.isPending || archived.isPending) return { kind: "problem", text: copy.retired.loading, pending: true };
  const chats = [...live.data, ...archived.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { kind: "found", hob: hob.data, chats };
};

function ReadHeader({ hob, title, meta }: { hob: Agent; title: string; meta: string }) {
  return (
    <header className="flex min-w-0 items-center gap-3.5">
      <DimPortrait hob={hob} size="header" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <h1
          title={title}
          className="m-0 line-clamp-2 font-(family-name:--font-heading) text-2xl leading-[30px] font-(--heading-weight) break-words [font-variant-ligatures:none]"
        >
          {title}
        </h1>
        <span className="truncate text-xs text-label">{meta}</span>
      </span>
    </header>
  );
}

/** The chat's messages as they were, with nothing to answer. */
function Transcript({ hob, threadId }: { hob: Agent; threadId: ThreadId }) {
  const transcript = useQuery({
    ...messagesQuery(threadId),
    select: (all) => all.filter((m) => m.status !== "queued"),
  });
  if (transcript.isError) {
    return (
      <p role="alert" className="m-0 text-sm text-rose">
        {copy.read.loadFailed}
      </p>
    );
  }
  if (transcript.isPending) {
    return (
      <p role="status" className="m-0 text-sm text-label">
        {copy.read.loading}
      </p>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-3.5">
      {transcript.data.map((message) => (
        <MessageRow key={message.id} message={message} hob={hob} />
      ))}
    </div>
  );
}

/** The bar that stays at the bottom of a read-only chat. */
function ReadOnlyBar({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="sticky bottom-4 flex items-center gap-3 rounded-card border border-line-2 bg-panel py-3 ps-4 pe-3 shadow-sheet">
      <span className="flex text-label">
        <LockIcon />
      </span>
      <span className="min-w-0 flex-1 text-sm leading-5 text-text-secondary">{text}</span>
      {children}
    </div>
  );
}

/** A page that could not show what its address asks for, with a way back. */
function Problem({
  crumb,
  text,
  pending = false,
  children,
}: {
  crumb: Crumb;
  text: string;
  pending?: boolean;
  children?: ReactNode;
}) {
  return (
    <ArchiveFrame label={copy.title} wide={false}>
      <Crumbs trail={[crumb.to === "/archive" ? archiveCrumb : crumb]} current={copy.title} />
      <div className="flex flex-col items-start gap-2">
        <p role={pending ? "status" : "alert"} className="m-0 text-text-secondary">
          {text}
        </p>
        {children}
      </div>
    </ArchiveFrame>
  );
}
