import type { HobToday, MembersReport } from "@hobbots/api";
import {
  type Agent,
  AgentId,
  type Channel,
  type ChannelMember,
  ChannelMembers,
  hobActor,
  takesNewWork,
} from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { useId, useState } from "react";
import { useChannelRuns } from "../../api/hub-status.ts";
import { useAddMember, useRemoveMember } from "../../api/members.ts";
import { formatCompact } from "../../lib/format.ts";
import { formatDay, formatTime } from "../../lib/time.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { CheckBox, hobRoleLine } from "./hob-picker.tsx";
import { type MemberError, memberError } from "./member-error.ts";
import { messages } from "./messages.ts";
import { linkButton, row, sectionTitle } from "./sheet-styles.ts";

// The members sheet's Hobs section (ADR 039, Members): each hob, what it is doing and spent here
// today, Add a hob, and taking a hob out.

const copy = messages.sheet;

/** The camp's hobs, the lead marked, with Add a hob and a way to take out each hob but the lead. */
export function HobsSection({
  camp,
  report,
  hobs,
  members,
}: {
  camp: Channel;
  report: MembersReport;
  hobs: ReadonlyArray<Agent>;
  members: ReadonlyArray<ChannelMember>;
}) {
  const [adding, setAdding] = useState(false);
  const add = useAddMember(camp.id);
  const remove = useRemoveMember(camp.id);
  const [failure, setFailure] = useState<{ readonly error: MemberError; readonly name: string } | null>(null);
  const headingId = useId();
  const runs = useChannelRuns()[camp.id];
  const inCamp = new Set(members.map((member) => member.actor.id));
  // Every hob that takes new work and is not here yet, a hob taken out included.
  const joinable = hobs.filter((hob) => takesNewWork(hob) && !inCamp.has(hob.id));
  const failed = (name: string) => (error: unknown) => setFailure({ error: memberError(error), name });
  // An archived camp is read-only: it lists who was here and changes no one until it is brought back.
  const archived = camp.archivedAt !== null;
  const busy = add.isPending || remove.isPending;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 className={sectionTitle}>
        <span id={headingId} className="flex-1">
          {copy.hobs({ total: members.length })}
        </span>
        {!archived && (
          <button
            type="button"
            className={linkButton}
            aria-expanded={adding}
            onClick={() => {
              setFailure(null);
              setAdding((open) => !open);
            }}
          >
            {adding ? copy.doneAdding : copy.addHob}
          </button>
        )}
      </h3>
      {archived && <p className="m-0 text-meta text-label">{copy.archived}</p>}
      <ul aria-labelledby={headingId} className="m-0 flex list-none flex-col p-0">
        {members.map((member) => {
          const hob = hobs.find((each) => each.id === member.actor.id);
          const name = hob?.name ?? member.actor.id;
          return (
            <HobRow
              key={member.actor.id}
              member={member}
              hob={hob}
              lead={member.actor.id === camp.ownerHobId}
              today={report.today.find((each) => each.hobId === member.actor.id)}
              speaking={runs?.speaking ?? null}
              next={runs?.next ?? []}
              busy={busy}
              removable={!archived}
              onRemove={() => {
                setFailure(null);
                remove.mutate(member.actor, { onError: failed(name) });
              }}
            />
          );
        })}
      </ul>
      {adding && !archived && (
        <AddList
          hobs={joinable}
          busy={busy}
          onAdd={(hob) => {
            setFailure(null);
            add.mutate(hobActor(AgentId.make(hob.id)), { onError: failed(hob.name) });
          }}
        />
      )}
      {failure !== null && (
        <p role="alert" className="m-0 text-meta text-rose">
          {copy.errors[failure.error]({ name: failure.name })}
        </p>
      )}
    </section>
  );
}

/** One hob in the camp: its face and name, Lead on the lead, what it is doing, today's spend here. */
function HobRow({
  member,
  hob,
  lead,
  today,
  speaking,
  next,
  busy,
  removable,
  onRemove,
}: {
  member: ChannelMember;
  hob: Agent | undefined;
  lead: boolean;
  today: HobToday | undefined;
  speaking: AgentId | null;
  next: ReadonlyArray<AgentId>;
  busy: boolean;
  /** Whether the camp takes member changes at all: an archived one does not. */
  removable: boolean;
  onRemove: () => void;
}) {
  const name = hob?.name ?? member.actor.id;
  return (
    <li className={row}>
      {hob === undefined ? <span aria-hidden className="size-8" /> : <HobTile hob={hob} tile="md" />}
      <span className="flex min-w-0 flex-col">
        <b className="flex items-center gap-1.5 text-ui font-semibold">
          <span className="truncate">{name}</span>
          {lead && <Badge variant="muted">{copy.lead}</Badge>}
        </b>
        <HobLine member={member} today={today} speaking={speaking} next={next} />
      </span>
      <span className="flex items-center gap-1">
        <span className="text-end text-meta text-label">
          {copy.turns({ turns: today?.turns ?? 0 })}
          <br />
          {copy.tokens({ tokens: formatCompact(today?.tokens ?? 0) })}
        </span>
        {/* A hob that retired left the camp, and comes back with it when it returns: nothing to take out. */}
        {removable && !lead && ChannelMembers.isActive(member) && (
          <button
            type="button"
            aria-label={copy.remove({ name })}
            title={copy.remove({ name })}
            disabled={busy}
            onClick={onRemove}
            className="inline-flex size-hit-min cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-secondary hover:bg-hover hover:text-text-strong focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-60"
          >
            <svg aria-hidden viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M1 1l10 10M11 1L1 11" />
            </svg>
          </button>
        )}
      </span>
    </li>
  );
}

/** What a hob in the camp is doing, as the hub publishes the camp's floor, or when it last answered. */
function HobLine({
  member,
  today,
  speaking,
  next,
}: {
  member: ChannelMember;
  today: HobToday | undefined;
  speaking: AgentId | null;
  next: ReadonlyArray<AgentId>;
}) {
  if (!ChannelMembers.isActive(member)) return <small className="truncate text-meta text-label">{copy.left}</small>;
  if (speaking === member.actor.id) return <small className="truncate text-meta text-mint">{copy.speaking}</small>;
  if (next.some((hobId) => hobId === member.actor.id)) {
    return <small className="truncate text-meta text-text-secondary">{copy.waiting}</small>;
  }
  const answered = today?.lastAnsweredAt ?? null;
  return (
    <small className="truncate text-meta text-text-secondary">
      {answered === null ? copy.idle : answeredLine(answered)}
    </small>
  );
}

/** The hobs that can join, each added at once with a click. */
function AddList({ hobs, busy, onAdd }: { hobs: ReadonlyArray<Agent>; busy: boolean; onAdd: (hob: Agent) => void }) {
  const labelId = useId();
  if (hobs.length === 0) return <p className="m-0 text-meta text-label">{copy.noneToAdd}</p>;
  return (
    <div className="flex max-h-[200px] flex-col gap-px overflow-auto rounded-control bg-card p-1 border-(length:--edge) border-line">
      <span id={labelId} className="px-2 pt-1.5 pb-0.5 text-meta font-bold text-label">
        {copy.adding}
      </span>
      <ul aria-labelledby={labelId} className="m-0 flex list-none flex-col gap-px p-0">
        {hobs.map((hob) => (
          <li key={hob.id}>
            <button
              type="button"
              aria-label={copy.add({ name: hob.name })}
              disabled={busy}
              onClick={() => onAdd(hob)}
              className="grid w-full cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control border-0 bg-transparent px-2 py-1.5 text-start text-ui text-text-strong hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-default"
            >
              <HobTile hob={hob} tile="md" />
              <span className="flex min-w-0 flex-col">
                <b className="truncate font-semibold">{hob.name}</b>
                <small className="truncate text-meta text-label">{hobRoleLine(hob)}</small>
              </span>
              <CheckBox checked={false} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** When a hob last answered here: the time today, else the day. */
const answeredLine = (iso: string, now: Date = new Date()) =>
  new Date(iso).toDateString() === now.toDateString()
    ? copy.answeredAt({ time: formatTime(iso) })
    : copy.answeredOn({ day: formatDay(iso, now) });
