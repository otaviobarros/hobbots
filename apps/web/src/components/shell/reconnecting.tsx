import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { createContext, type ReactNode, useContext } from "react";
import { hubNameOf, isLoopbackHost } from "../../lib/hub-name.ts";
import { messages } from "../messages.ts";

const copy = messages.deviceAccess;

/** Whether the live stream is down and how to try again, from the app shell to the page it holds. */
interface Reconnecting {
  readonly down: boolean;
  /** The hub gave no answer at all, as when it is off or remote access is paused. */
  readonly unreachable: boolean;
  readonly retry: () => void;
}

const ReconnectingContext = createContext<Reconnecting>({ down: false, unreachable: false, retry: () => {} });

export function ReconnectingProvider({ value, children }: { value: Reconnecting; children: ReactNode }) {
  return <ReconnectingContext.Provider value={value}>{children}</ReconnectingContext.Provider>;
}

/**
 * Why the stream is down, in the card's words. A device on the tailnet that gets no answer at all
 * says the hub may be off or remote access paused (ADR 021); on the hub's own computer, pausing
 * changes nothing, so it only reconnects.
 */
const reconnectingText = (unreachable: boolean) => {
  const hostname = globalThis.location?.hostname ?? "";
  if (!unreachable || isLoopbackHost(hostname)) return copy.reconnecting;
  const hub = hubNameOf(hostname);
  return hub === null ? copy.unreachableNoName : copy.unreachable({ hub });
};

/**
 * "Reconnecting to Hobbots…" as a lantern-tinted card with a spinner and Try now: under the chat's
 * header in a chat, and at the top of any other page.
 */
export function ReconnectingCard({ className }: { className?: string }) {
  const { down, unreachable, retry } = useContext(ReconnectingContext);
  if (!down) return null;
  return (
    <div
      role="status"
      className={cn(
        "flex flex-none animate-hb-in items-center gap-3 rounded-card border border-[color-mix(in_srgb,var(--color-lantern)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-lantern)_12%,var(--color-card))] py-2.5 ps-3.5 pe-3 text-sm text-text-strong",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-3.5 flex-none animate-spin rounded-dot border-2 border-lantern/30 border-t-lantern motion-reduce:animate-none"
      />
      <span className="flex-1">{reconnectingText(unreachable)}</span>
      <Button variant="outline" size="xs" onClick={retry}>
        {copy.tryNow}
      </Button>
    </div>
  );
}
