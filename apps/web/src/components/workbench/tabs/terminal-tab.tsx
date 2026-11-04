import { lazy, Suspense, useState } from "react";
import { commandLogUrl } from "../../../api/client.ts";
import { formatBytes } from "../../../lib/format.ts";
import { LogLink } from "../../chat/tool-output.tsx";
import { useNow } from "../../inbox/use-now.ts";
import { messages } from "../messages.ts";
import { anyRunning, foldedWithLog, hobTerminals, tallyCommands } from "../terminal-model.ts";
import { useTerminalActivity } from "../use-terminal-activity.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const copy = messages.terminal;

/** The terminals and xterm.js load in their own chunk, the first time the tab opens (STD-REACT-023). */
const TerminalPanes = lazy(() => import("../terminal-panes.tsx").then((module) => ({ default: module.TerminalPanes })));

/**
 * The Terminal tab (ADR 023, #908): what each hob in the Quest ran, replayed in a real terminal.
 * A read-only record: a terminal per hob, the Task's own first, each command's prompt line and its
 * output as printed, colors included, Live while a turn runs and History afterwards. xterm.js
 * loads the first time the tab opens, and stays loaded so each terminal keeps its scroll.
 */
export function TerminalTab({ tree, task, attempt, activity, hobs, shown }: WorkbenchTabProps) {
  const [opened, setOpened] = useState(shown);
  if (shown && !opened) setOpened(true);
  const read = useTerminalActivity(tree, task, attempt);
  const terminals = hobTerminals(tree, task, read.activities);
  const commands = terminals.flatMap((each) => each.commands);
  // The clock ticks each second only while a command runs.
  const now = useNow(anyRunning(commands) ? 1000 : null);
  if (activity === null) return <div data-slot="terminal" />;
  const folded = foldedWithLog(commands);
  return (
    <div data-slot="terminal" className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-detail text-text-secondary">
        {commands.length > 0 && <span className="text-text-strong">{copy.tally(tallyCommands(commands))}</span>}
        <span className="text-label">{copy.readOnly}</span>
      </p>
      {commands.length === 0 ? (
        <p className="m-0 text-detail text-text-secondary">{copy.none}</p>
      ) : (
        opened && (
          // Until it has loaded, the space stays empty, so nothing flashes.
          <Suspense fallback={<div className="min-h-0 flex-1" />}>
            <TerminalPanes terminals={terminals} live={read.live} hobs={hobs} now={now} />
          </Suspense>
        )
      )}
      {folded.length > 0 && (
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-meta text-label">
          <span>{copy.fullLogs}</span>
          {folded.map((each) => (
            <LogLink key={each.id} href={commandLogUrl(each.attemptId, each.id)}>
              {copy.logOf({ command: each.command, size: formatBytes(each.log?.totalBytes ?? 0) })}
            </LogLink>
          ))}
        </p>
      )}
    </div>
  );
}
