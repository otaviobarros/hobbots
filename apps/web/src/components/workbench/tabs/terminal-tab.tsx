import { type AttemptId, type CommandRecord, runsInSequence } from "@hobbots/domain";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@hobbots/ui/components/collapsible";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { commandLogUrl } from "../../../api/client.ts";
import { type LiveOutput, liveOutputQuery } from "../../../api/workbench.ts";
import { formatBytes, formatDuration } from "../../../lib/format.ts";
import { formatTime } from "../../../lib/time.ts";
import { LogLink, OUTPUT_TEXT, OutputBlock } from "../../chat/tool-output.tsx";
import { useNow } from "../../inbox/use-now.ts";
import { messages } from "../messages.ts";
import {
  anyRunning,
  commandDuration,
  commandsInOrder,
  showsLive,
  tallyCommands,
  wholeOutput,
} from "../terminal-model.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const copy = messages.terminal;

/** The mark before each command, and its color. A running one blinks until Reduce motion stops it. */
const MARK: Record<CommandRecord["state"], { readonly glyph: string; readonly className: string }> = {
  running: { glyph: "●", className: "animate-hb-blink text-lantern" },
  succeeded: { glyph: "✓", className: "text-mint" },
  failed: { glyph: "✗", className: "text-rose" },
  uncertain: { glyph: "?", className: "font-bold text-lantern" },
};

/**
 * The Terminal tab (ADR 023): the commands the Task ran and what they printed. A read-only record:
 * Live while a turn runs, as each command starts and, where the brain reports it, as it prints;
 * History afterwards. Each command says where it ran, in the sandbox or not, when, for how long and
 * whether it succeeded. Output is redacted by the hub before it is kept, and long output is folded.
 */
export function TerminalTab({ activity, attempt }: WorkbenchTabProps) {
  const commands = commandsInOrder(activity?.commands ?? []);
  // The clock ticks each second only while a command runs.
  const now = useNow(anyRunning(commands) ? 1000 : null);
  const live = useQuery({ ...liveOutputQuery(attempt?.id ?? ("" as AttemptId)), enabled: attempt !== null }).data;
  if (activity === null) return <div data-slot="terminal" />;
  return (
    <div data-slot="terminal" className="flex flex-col gap-3 px-5 py-4">
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-detail text-text-secondary">
        {commands.length > 0 && <span className="text-text-strong">{copy.tally(tallyCommands(commands))}</span>}
        <span className="text-label">{copy.readOnly}</span>
      </p>
      {commands.length === 0 ? (
        <p className="m-0 text-detail text-text-secondary">{copy.none}</p>
      ) : (
        <ol aria-label={copy.commands} className="m-0 flex list-none flex-col gap-2 p-0">
          {commands.map((command) => (
            <li key={command.id} data-state={command.state}>
              <CommandEntry command={command} now={now} live={live?.[command.id]} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One command: its line and state, opening to where and when it ran and what it printed. */
function CommandEntry({ command, now, live }: { command: CommandRecord; now: Date; live: LiveOutput | undefined }) {
  const mark = MARK[command.state];
  const duration = commandDuration(command, now);
  return (
    <Collapsible
      defaultOpen
      className="flex flex-col gap-1.5 rounded-card border-(length:--edge) border-line bg-panel px-3 py-2"
    >
      <CollapsibleTrigger className="group flex min-w-0 items-start gap-2 border-0 bg-transparent p-0 text-start text-detail text-text-strong hover:text-moonlight focus-visible:outline-2 focus-visible:outline-focus-ring">
        <span aria-hidden className={cn("w-3.5 shrink-0 text-center", mark.className)}>
          {mark.glyph}
        </span>
        <code className="min-w-0 flex-1 font-mono text-meta leading-normal break-all whitespace-pre-wrap">
          <span aria-hidden className="text-label">
            ${" "}
          </span>
          {command.command}
        </code>
        <StateText command={command} duration={duration} />
        <span aria-hidden className="text-label group-data-[state=open]:rotate-90">
          ›
        </span>
      </CollapsibleTrigger>
      {command.state === "uncertain" && <span className="ps-5.5 text-meta text-lantern">{copy.uncertain}</span>}
      <CollapsibleContent className="flex flex-col gap-1.5">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 ps-5.5 text-meta text-text-secondary">
          <dt className="text-label">{copy.folder}</dt>
          <dd className="m-0 font-mono break-all">{command.folder}</dd>
          <dt className="text-label">{copy.sandbox}</dt>
          <dd className={cn("m-0", !command.sandboxed && "font-bold text-rose")}>
            {command.sandboxed ? copy.inSandbox : copy.unsandboxed}
          </dd>
          <dt className="text-label">{copy.started}</dt>
          <dd className="m-0">{formatTime(command.startedAt)}</dd>
          {command.state !== "running" && duration !== null && (
            <>
              <dt className="text-label">{copy.took}</dt>
              <dd className="m-0">{formatDuration(duration)}</dd>
            </>
          )}
        </dl>
        <Printed command={command} live={live} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * "Running · 12 sec", "Succeeded", "Failed · exit code 1" or "Cut off". A line of commands run one
 * after another that exited 0 only "Finished": its earlier commands may have failed.
 */
function StateText({ command, duration }: { command: CommandRecord; duration: number | null }) {
  const state = copy.state;
  const partly = command.state === "succeeded" && runsInSequence(command.command);
  const text =
    command.state === "running"
      ? state.running({ time: formatDuration(duration ?? 0) })
      : command.state === "failed" && command.exitCode !== null
        ? `${state.failed} · ${copy.exitCode({ code: command.exitCode })}`
        : partly
          ? copy.finishedInSequence
          : state[command.state];
  return (
    <span
      className={cn(
        "shrink-0 text-meta",
        command.state === "failed"
          ? "text-rose"
          : command.state === "succeeded" && !partly
            ? "text-mint"
            : "text-lantern",
      )}
    >
      {text}
    </span>
  );
}

/**
 * What the command printed: its output as it comes while it runs, where the brain reports it so,
 * else that it shows at the end; once it ended, its record's start and end with the whole log.
 */
function Printed({ command, live }: { command: CommandRecord; live: LiveOutput | undefined }) {
  if (showsLive(command)) return <LiveOutputBlock live={live} />;
  if (command.state === "running") return <p className="m-0 ps-5.5 text-meta text-label">{copy.atEnd}</p>;
  if (command.output === null) return null;
  return <OutputBlock output={command.output} className="ms-5.5" whole={<WholeLog command={command} />} />;
}

/** A running command's output as it comes, kept scrolled to its last line. */
function LiveOutputBlock({ live }: { live: LiveOutput | undefined }) {
  return (
    <figure
      aria-label={copy.liveOutput}
      className="m-0 ms-5.5 flex min-w-0 flex-col overflow-hidden rounded-card border-(length:--edge) border-line bg-deep"
    >
      <figcaption className="border-b-(length:--edge) border-line px-2.5 py-1 text-meta text-label">
        {copy.liveOutput}
      </figcaption>
      {live?.missed && (
        <p className="m-0 border-b-(length:--edge) border-line px-2.5 py-1 text-meta text-label">{copy.missed}</p>
      )}
      {/* Reversed, so the newest line shows and the rest scrolls up. */}
      <div className="flex max-h-60 flex-col-reverse overflow-auto">
        <pre role="log" aria-live="polite" className={cn(OUTPUT_TEXT, "max-h-none overflow-visible")}>
          {live === undefined || live.text === "" ? <span className="text-label">{copy.waiting}</span> : live.text}
        </pre>
      </div>
    </figure>
  );
}

/** The link to a command's whole output, or why there is none. */
function WholeLog({ command }: { command: CommandRecord }) {
  const whole = wholeOutput(command);
  if (whole.kind === "not-kept") {
    const reason = whole.reason === "cleared" || whole.reason === "attempt-limit" ? whole.reason : "other";
    return <span className="text-label">{copy.noLog[reason]}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <LogLink href={commandLogUrl(command.attemptId, command.id)}>
        {copy.openLog({ size: formatBytes(whole.totalBytes) })}
      </LogLink>
      {whole.omittedBytes > 0 && (
        <span className="text-label">{copy.logCut({ size: formatBytes(whole.omittedBytes) })}</span>
      )}
    </span>
  );
}
