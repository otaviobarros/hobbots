import { Button } from "@hobbots/ui/components/button";
import { useId } from "react";
import { LONG_WAIT_MS, minutesSince, type ReplyRun, type ReplyWait } from "../../lib/reply-wait.ts";
import { useNow } from "../inbox/use-now.ts";
import { messages } from "../messages.ts";

const copy = messages.composer;

/** The still mark of a reply that waits on a command. */
const WAIT_MARK = "◷";

/** A reply that runs: every mode of `ReplyRun` but idle. */
export type RunningReply = Exclude<ReplyRun, { readonly mode: "idle" }>;

/** What the reply waits on, in a mode that can wait. */
const waitOf = (run: RunningReply): ReplyWait | null => (run.mode === "replying" ? null : run.wait);

/**
 * While a reply runs, the hint is one line that never wraps: a blinking mint dot and who is
 * replying, or when a draft will go. Beside the Quest room it keeps only the dot and one word. The
 * longer sentence is Stop's description.
 */
export function BusyHint({ name, run, drafting }: { name: string; run: RunningReply; drafting: boolean }) {
  const stopping = run.mode === "stopping";
  const wait = waitOf(run);
  if (wait !== null) return <WaitHint name={name} stopping={stopping} drafting={drafting} wait={wait} />;
  const full = stopping ? copy.hintStopping({ name }) : drafting ? copy.hintSendsAfter : copy.hintReplying({ name });
  return (
    <span
      aria-live="polite"
      className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-meta whitespace-nowrap text-text-secondary"
    >
      {!stopping && <span aria-hidden className="size-2 flex-none animate-hb-blink rounded-dot bg-mint" />}
      <span className="truncate @max-[480px]/chat:hidden">{full}</span>
      <span className="hidden truncate @max-[480px]/chat:inline">
        {stopping ? copy.hintStoppingShort : copy.hintReplyingShort}
      </span>
    </span>
  );
}

/** The commands a wait names: the one, or none when there are several. */
const lone = (wait: ReplyWait): string | null => (wait.commands.length === 1 ? (wait.commands[0] ?? null) : null);

/**
 * Once the hob has answered and the reply waits only on commands it started (#1056): a still mint ◷,
 * what it waits on and for how long, counted once a minute. After a long wait it adds that the
 * command may not end on its own, in the same quiet color. Beside the Quest room it keeps the mark,
 * one word and the time.
 */
function WaitHint({
  name,
  stopping,
  drafting,
  wait,
}: {
  name: string;
  stopping: boolean;
  drafting: boolean;
  wait: ReplyWait;
}) {
  const now = useNow(60_000);
  const minutes = minutesSince(wait.since, now);
  const time = copy.minutes({ count: minutes });
  const command = lone(wait);
  const long = minutes * 60_000 >= LONG_WAIT_MS;
  const waiting =
    command === null
      ? copy.hintWaitingMany({ name, count: wait.commands.length, time })
      : copy.hintWaiting({ name, command, time });
  const full = stopping
    ? command === null
      ? copy.hintStoppingWaitMany({ name })
      : copy.hintStoppingWait({ name, command })
    : drafting
      ? command === null
        ? copy.hintSendsWhenAllEnd
        : copy.hintSendsWhenEnds({ command })
      : long
        ? `${waiting}. ${copy.hintWaitingLong}`
        : waiting;
  return (
    <span
      aria-live="polite"
      className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-meta whitespace-nowrap text-text-secondary"
    >
      {!stopping && (
        <span aria-hidden className="flex-none text-mint">
          {WAIT_MARK}
        </span>
      )}
      <span className="truncate @max-[480px]/chat:hidden">{full}</span>
      <span className="hidden truncate @max-[480px]/chat:inline">
        {stopping ? copy.hintStoppingShort : copy.hintWaitingShort({ time })}
      </span>
    </span>
  );
}

/**
 * Stop, while a reply runs. Once the reply only waits on commands it becomes Stop waiting, which
 * keeps the reply's text (#1056). Its description says what it does.
 */
export function StopButton({
  name,
  run,
  onStop,
  onStopWaiting,
}: {
  name: string;
  run: RunningReply;
  onStop: () => void;
  onStopWaiting: (() => void) | undefined;
}) {
  const stopWhat = useId();
  const stopping = run.mode === "stopping";
  const wait = waitOf(run);
  const waiting = wait !== null && onStopWaiting !== undefined;
  const description = waiting
    ? copy.stopWaitingDescription({ name, command: lone(wait) ?? copy.theCommands })
    : copy.stopDescription({ name });
  const label = waiting ? copy.stopWaiting : copy.stop;
  return (
    <>
      <Button
        variant="deny"
        size="bar"
        onClick={waiting ? onStopWaiting : onStop}
        disabled={stopping}
        aria-describedby={stopWhat}
        title={description}
      >
        {stopping ? copy.stopping : label}
      </Button>
      <span id={stopWhat} hidden>
        {description}
      </span>
    </>
  );
}
