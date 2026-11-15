import {
  type Agent,
  type AgentId,
  HOB_RELAY_BUDGET,
  type Channel,
  type ChannelId,
  ChannelLifecycle,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { useChannelRuns } from "../../api/hub-status.ts";
import { useLetHobsGoOn } from "../../api/queries.ts";
import { formatList } from "../../lib/format.ts";
import { messages } from "../messages.ts";

const copy = messages.chat.hobsPaused;

/** The names of the hobs a relay paused between, as the card says them; a hob not known by name is left out. */
const pausedNames = (paused: ReadonlyArray<AgentId>, hobs: ReadonlyArray<Agent>): string => {
  const names = paused.flatMap((hobId) => hobs.find((hob) => hob.id === hobId)?.name ?? []);
  return names.length === 0 ? copy.someHobs : formatList(names);
};

/**
 * "Hobs paused, waiting for a person" (ADR 039, Hobs talking to hobs; #1463): the hub stopped the
 * hobs that kept answering each other after `HOB_RELAY_BUDGET` turns. Let them go on gives them that
 * many turns again; your next message takes over instead. It shows while the hub publishes the
 * open channel's run with paused hobs, and never works that out from the messages.
 */
export function HobsPaused({
  channel,
  hobs,
}: {
  /** The channel shown, once it is known. */
  channel: Channel | undefined;
  /** The hobs whose names the card can say, once they are loaded. */
  hobs: ReadonlyArray<Agent> | undefined;
}) {
  const channelId = channel?.id ?? ("" as ChannelId);
  const paused = useChannelRuns()[channelId]?.paused ?? [];
  const goOn = useLetHobsGoOn(channelId);
  if (channel === undefined || paused.length === 0 || !ChannelLifecycle.isOpen(channel)) return null;
  return (
    <section
      aria-label={copy.title}
      className="flex max-w-work-max animate-hb-in flex-wrap items-center gap-3 rounded-card border-(length:--edge) border-line-2 bg-card px-4 py-3"
    >
      <span
        aria-hidden
        className="inline-flex size-7.5 shrink-0 items-center justify-center rounded-full bg-line font-bold text-text-secondary"
      >
        {copy.glyph}
      </span>
      <span className="flex min-w-0 flex-1 basis-56 flex-col">
        <b className="text-body font-semibold text-text-strong">{copy.title}</b>
        <small className="text-detail text-label">
          {copy.detail({ names: pausedNames(paused, hobs ?? []), count: HOB_RELAY_BUDGET })}
        </small>
        {goOn.isError && (
          <span role="alert" className="text-detail text-rose">
            {copy.goOnFailed}
          </span>
        )}
      </span>
      <Button variant="outline" size="sm" disabled={goOn.isPending} onClick={() => goOn.mutate()}>
        {goOn.isPending ? copy.goingOn : copy.goOn}
      </Button>
    </section>
  );
}
