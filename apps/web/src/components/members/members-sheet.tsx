import type { MembersReport } from "@hobbots/api";
import { type Thread, type ThreadMember, ThreadMembers } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Sheet, SheetCloseButton, SheetContent, SheetHeader, SheetTitle } from "@hobbots/ui/components/sheet";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { membersToday } from "../../api/members.ts";
import { agentsQuery } from "../../api/queries.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { PersonBadge } from "../sidebar/sidebar-faces.tsx";
import { HobsSection } from "./hobs-section.tsx";
import { messages } from "./messages.ts";
import { CostSection, PeopleSection } from "./people-sections.tsx";

const copy = messages.sheet;

/** The members the sheet lists: everyone not taken out, with the lead first among the hobs. */
const shownMembers = (members: ReadonlyArray<ThreadMember>, lead: string): ReadonlyArray<ThreadMember> => {
  const isLead = (member: ThreadMember) => member.actor.kind === "hob" && member.actor.id === lead;
  return members.filter((member) => member.state !== "removed").sort((a, b) => Number(isLead(b)) - Number(isLead(a)));
};

/**
 * A camp's members sheet (ADR 039, Members; Cards every thread shares › Status and cost; Screens ›
 * GroupChatMembers): its hobs, the one that leads its quests marked Lead, what each is doing and
 * its turns and tokens here today; its people, the owner marked; and what today cost on whose plan.
 * Add a hob lists the hobs that can join; each hob but the lead can be taken out, which drops what
 * it still owed here.
 */
export function MembersSheet({ camp, onClose }: { camp: Thread; onClose: () => void }) {
  const read = useQuery(membersToday(camp.id));
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent aria-describedby={undefined} aria-busy={read.isPending}>
        {read.data === undefined ? (
          <>
            <SheetHeader>
              <span className="text-meta font-semibold text-star">{copy.loading}</span>
              <SheetCloseButton label={copy.close} />
            </SheetHeader>
            <SheetTitle>{camp.title}</SheetTitle>
            {read.isError ? (
              <div role="alert" className="flex flex-col items-start gap-2 text-ui text-text-secondary">
                {copy.failed}
                <Button variant="outline" size="xs" onClick={() => void read.refetch()}>
                  {copy.retry}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Skeleton width="100%" />
                <Skeleton width="80%" />
              </div>
            )}
          </>
        ) : (
          <SheetBody camp={camp} report={read.data} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({ camp, report }: { camp: Thread; report: MembersReport }) {
  const hobs = useQuery(agentsQuery).data ?? [];
  const shown = shownMembers(report.members, camp.agentId);
  const hobMembers = shown.filter((member) => member.actor.kind === "hob");
  const people = shown.filter((member) => member.actor.kind === "user");
  return (
    <>
      <SheetHeader>
        <span className="text-meta font-semibold text-star">
          {copy.eyebrow({ people: people.length, hobs: hobMembers.length })}
        </span>
        <SheetCloseButton label={copy.close} />
      </SheetHeader>
      <div className="flex flex-col gap-1">
        <SheetTitle>{camp.title}</SheetTitle>
        {camp.goal !== null && <span className="text-ui text-text-secondary">{copy.goal({ goal: camp.goal })}</span>}
      </div>
      <p className="m-0 text-meta text-label">{hobMembers.length > 1 ? copy.several : copy.one}</p>
      <HobsSection camp={camp} report={report} hobs={hobs} members={hobMembers} />
      <PeopleSection report={report} members={people} />
      <CostSection report={report} hobs={hobs} members={hobMembers} />
      <p className="m-0 text-meta text-label">{copy.memory}</p>
    </>
  );
}

/**
 * The camp header's members button (Screens › GroupChat): the faces of up to four members besides
 * you and how many are in the camp, opening the members sheet.
 */
export function MembersButton({ camp, open, onOpen }: { camp: Thread; open: boolean; onOpen: () => void }) {
  const report = useQuery(membersToday(camp.id)).data;
  const hobs = useQuery(agentsQuery).data ?? [];
  const active = (report?.members ?? []).filter(ThreadMembers.isActive);
  const faces = active.filter((member) => member.role !== "owner").slice(0, 4);
  return (
    <button
      type="button"
      aria-label={copy.button({ total: active.length })}
      aria-expanded={open}
      onClick={onOpen}
      className="inline-flex h-[34px] shrink-0 cursor-pointer items-center gap-2 rounded-control border-(length:--edge) border-line-2 bg-transparent ps-1.5 pe-2.5 text-detail font-semibold text-text-strong hover:bg-hover aria-expanded:border-control aria-expanded:bg-card focus-visible:outline-2 focus-visible:outline-focus-ring @max-[520px]/header:ps-2.5"
    >
      <span
        aria-hidden
        className="flex items-center @max-[520px]/header:hidden *:-ms-1.5 *:shadow-[0_0_0_2px_var(--color-ground)] *:first:ms-0"
      >
        {faces.map((member) => {
          const hob = hobs.find((each) => each.id === member.actor.id);
          const person = report?.people.find((user) => user.id === member.actor.id);
          if (hob !== undefined) return <HobTile key={member.actor.id} hob={hob} tile="sm" />;
          return person === undefined ? null : <PersonBadge key={member.actor.id} person={person} size="sm" />;
        })}
      </span>
      {active.length > 0 ? active.length : ""}
    </button>
  );
}
