import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { restoreStatusQuery, workHeld } from "../../api/backup.ts";
import { ResumeWorkButton } from "./backup-settings.tsx";
import { messages } from "./messages.ts";

/** "Work is held after a restore", with Resume work, on Home and the Quest tab (ADR 026). Nothing otherwise. */
export function WorkHeldNotice({ className }: { className?: string }) {
  const status = useQuery(restoreStatusQuery);
  if (!workHeld(status.data)) return null;
  return (
    <section
      aria-label={messages.latest.held}
      className={`cut flex flex-col gap-1.5 border-2 border-lantern bg-deep px-4 py-3 ${className ?? ""}`}
    >
      <span className="font-bold text-lantern">{messages.latest.held}</span>
      <span className="text-sm text-text-secondary">{messages.latest.heldNote}</span>
      <span className="flex flex-wrap items-center gap-3">
        <ResumeWorkButton />
        <Link
          to="/settings/$section"
          params={{ section: "data" }}
          className="text-sm text-lantern no-underline hover:underline"
        >
          {messages.heading}
        </Link>
      </span>
    </section>
  );
}
