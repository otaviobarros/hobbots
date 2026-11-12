import { Badge } from "@hobbots/ui/components/badge";
import { CardFooter } from "./card-footer.tsx";
import { messages } from "./messages.ts";
import { engineTag, keptLine } from "./model.ts";
import { OverviewCard } from "./overview-card.tsx";

const copy = messages;

/**
 * Settings › Your data › Memory (ADR 028): whether the memory engine runs and what it keeps, and
 * Show the files on the desktop app. The model it sums up with is the hub's brain, in its own card
 * above. Until the hub answers, still lines hold the card's place.
 */
export function MemorySettingsCard() {
  return (
    <OverviewCard
      id="memory"
      label={copy.card.label}
      tag={(data) => {
        const tag = engineTag(data.engine);
        return <Badge variant={tag.variant}>{tag.label}</Badge>;
      }}
    >
      {(data) => (
        <>
          <span className="text-ui text-text-secondary">{keptLine(data)}</span>
          <InAChat />
          <CardFooter version={data.engine?.version ?? null} />
        </>
      )}
    </OverviewCard>
  );
}

/** A hob saves notes during its own reply, with no extra model call, so this setting is not about them. */
function InAChat() {
  return (
    <div className="flex items-start gap-3 rounded-control bg-ground px-3 py-2.5">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width={16}
        height={16}
        className="mt-0.5 flex-none text-mint"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      </svg>
      <span className="flex flex-col gap-0.5">
        <span className="text-ui">
          <b>{copy.chat.title}</b>
          {copy.chat.body}
        </span>
        <span className="text-detail text-text-secondary">{copy.chat.note}</span>
      </span>
    </div>
  );
}
