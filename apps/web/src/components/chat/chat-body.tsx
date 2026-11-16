import { RUNTIME_NAMES, type RuntimeKind } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { messages } from "../messages.ts";

const copy = messages.chat;

/**
 * The chat under its header: the transcript and the composer in one column, and beside it `aside`,
 * such as a reply thread (ADR 039), which takes its own width rather than covering the chat.
 */
export function ChatBody({ aside, children }: { aside: ReactNode; children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      {aside}
    </div>
  );
}

/** The chat's brain can't think right now: what is wrong, and where to fix it. */
export function BrainProblem({
  name,
  runtime,
  problem,
}: {
  name: string;
  runtime: RuntimeKind;
  problem: keyof typeof copy.brain;
}) {
  return (
    <section
      aria-label={copy.brainUnavailable}
      className="flex flex-wrap items-center gap-2.5 rounded-card bg-card px-3.5 py-2.5 text-ui"
    >
      <span className="flex-1 text-lantern">
        {copy.brainProblem({ name, runtime: RUNTIME_NAMES[runtime], problem: copy.brain[problem] })}
      </span>
      <Button asChild variant="outline" size="xs">
        <Link to="/settings/$section" params={{ section: "connections" }}>
          {copy.fixInSettings}
        </Link>
      </Button>
    </section>
  );
}
