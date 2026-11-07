import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { MemoryCard } from "../memory/memory-parts.tsx";
import { messages } from "./messages.ts";
import { instructionsOf } from "./skills-model.ts";

const copy = messages;

/**
 * A skill's or a set's page: Skills and the trail to it as a breadcrumb, the header and what follows,
 * and the aside beside them.
 */
export function SkillLayout({
  trail,
  children,
  aside,
}: {
  /** After Skills: each step by its name, the last one where you are. */
  trail: ReadonlyArray<{ readonly key: string; readonly step: React.ReactNode }>;
  children: React.ReactNode;
  aside: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-7">
      <article className="flex min-w-0 max-w-[700px] flex-[1_1_520px] flex-col gap-4">
        <nav aria-label={copy.skill.breadcrumb} className="flex items-center gap-1.5 text-detail text-text-secondary">
          <Link to="/skills" search={{}} className="text-link">
            {copy.title}
          </Link>
          {trail.map(({ key, step }) => (
            <span key={key} className="flex items-center gap-1.5">
              <span aria-hidden>›</span>
              {step}
            </span>
          ))}
        </nav>
        {children}
      </article>
      {aside}
    </div>
  );
}

/** A page's header: its tags, its name, what it is for, and a byline. */
export function SkillHeader({
  tags,
  title,
  description,
  byline,
}: {
  tags: React.ReactNode;
  title: string;
  description: string;
  byline: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">{tags}</div>
      <h2 className="m-0 font-heading text-[28px] leading-[34px] font-bold text-text-strong">{title}</h2>
      <p className="m-0 text-body text-text">{description}</p>
      <p className="m-0 text-detail text-label">{byline}</p>
    </header>
  );
}

/** The aside's Actions card. */
export function ActionsCard({ children }: { children: React.ReactNode }) {
  return (
    <MemoryCard label={copy.skill.actions}>
      <h3 className="lbl m-0 text-label">{copy.skill.actions}</h3>
      {children}
    </MemoryCard>
  );
}

/** The aside's Where it came from card, its rows each a label and a value. */
export function OriginCard({ children }: { children: React.ReactNode }) {
  return (
    <MemoryCard label={copy.skill.origin}>
      <h3 className="lbl m-0 text-label">{copy.skill.origin}</h3>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-detail">{children}</dl>
    </MemoryCard>
  );
}

/** One row of Where it came from. */
export function OriginRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-label">{label}</dt>
      <dd className={cn("m-0", mono ? "font-mono" : "break-words")}>{children}</dd>
    </>
  );
}

/** A `SKILL.md`'s instructions as they are read: a skeleton, why they did not open, or the text. */
export function InstructionsText({
  read,
}: {
  read: { readonly isPending: boolean; readonly isError: boolean; readonly text: string | null | undefined };
}) {
  if (read.isPending)
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{copy.loading}</span>
        <Skeleton width="80%" />
        <Skeleton width="65%" />
      </div>
    );
  if (read.isError) return <p className="m-0 text-ui text-text-secondary">{copy.failed.skill}</p>;
  if (read.text == null) return null;
  return <ReplyMarkdown content={instructionsOf(read.text)} streaming={false} caret={false} />;
}
