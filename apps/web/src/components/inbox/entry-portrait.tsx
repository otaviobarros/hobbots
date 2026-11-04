import type { Agent } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { HobSprite } from "../hob-sprite.tsx";

/**
 * Who an Inbox entry comes from, on a tile: the hob's portrait, or a screen on a stand for a device
 * asking to join. `large` is the detail pane's size.
 */
export function EntryPortrait({
  hob,
  device,
  waiting,
  large = false,
}: {
  hob: Agent | undefined;
  device: boolean;
  waiting: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-tile bg-line text-text-secondary",
        large ? "size-11" : "mt-0.5 size-7.5",
      )}
    >
      {hob !== undefined && <HobSprite hob={hob} size={large ? 33 : 22} state={waiting ? "needs-you" : "idle"} />}
      {hob === undefined && device && (
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={large ? "size-5" : "size-4.5"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M3.5 5.5h13v8h-13zM1.5 15.5h17" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}
