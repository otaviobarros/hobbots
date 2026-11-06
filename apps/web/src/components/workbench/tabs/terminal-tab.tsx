import { useQueries } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { commandLogUrl } from "../../../api/client.ts";
import { type LiveOutputs, liveOutputQuery } from "../../../api/workbench.ts";
import { formatBytes } from "../../../lib/format.ts";
import { LogLink } from "../../chat/tool-output.tsx";
import { useNow } from "../../inbox/use-now.ts";
import { messages } from "../messages.ts";
import { anyRunning, foldedWithLog, hobTerminals, tallyCommands } from "../terminal-model.ts";
import type { WorkbenchTabProps } from "./tab-props.ts";

const copy = messages.terminal;

/** The terminals and xterm.js load in their own chunk, the first time the tab opens (STD-REACT-023). */
const TerminalPanes = lazy(() => import("../terminal-panes.tsx").then((module) => ({ default: module.TerminalPanes })));

/**
 * The Terminal tab (ADR 023, #908): what each hob in view ran, replayed in a real terminal. A
 * read-only record: a terminal per hob, each command's prompt line and its output as printed, colors
 * included, Live while a turn runs and History afterwards. xterm.js loads the first time the tab
 * opens, and stays loaded so each terminal keeps its scroll.
 */
export function TerminalTab({ tree, sources, hobs, shown }: WorkbenchTabProps) {
  const [opened, setOpened] = useState(shown);
  if (shown && !opened) setOpened(true);
  // What running commands printed so far comes from the stream, by Attempt.
  const outputs = useQueries({ queries: sources.map((each) => liveOutputQuery(each.attempt.id)) });
  const live: LiveOutputs = Object.assign({}, ...outputs.map((output) => output.data ?? {}));
  const first = sources[0]?.task ?? tree.tasks[0];
  const terminals =
    first === undefined
      ? []
      : hobTerminals(
          tree,
          first,
          sources.map((each) => each.activity),
        );
  const commands = terminals.flatMap((each) => each.commands);
  // The clock ticks each second only while a command runs.
  const now = useNow(anyRunning(commands) ? 1000 : null);
  if (sources.length === 0) return <div data-slot="terminal" />;
  const folded = foldedWithLog(commands);
  return (
    <div data-slot="terminal" className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
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
            <TerminalPanes terminals={terminals} live={live} hobs={hobs} now={now} />
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
