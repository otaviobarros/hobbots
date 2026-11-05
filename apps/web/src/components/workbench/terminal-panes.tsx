import type { AgentId } from "@hobbots/domain";
import {
  TerminalBar,
  TerminalButton,
  TerminalFrame,
  TerminalPane,
  TerminalSearchInput,
  TerminalTabsList,
  TerminalTabsTrigger,
} from "@hobbots/ui/components/terminal-frame";
import { cn } from "@hobbots/ui/lib/utils";
import { type KeyboardEvent, useRef, useState } from "react";
import { commandLogUrl } from "../../api/client.ts";
import type { LiveOutputs } from "../../api/workbench.ts";
import type { HobLookup } from "../quest/use-work.ts";
import type { SearchResult } from "../terminal/terminal-options.ts";
import { type TerminalHandle, TerminalScreen } from "../terminal/terminal-screen.tsx";
import { messages } from "./messages.ts";
import { type HobCommands, type TerminalMark, tallyCommands, terminalMark } from "./terminal-model.ts";
import { transcript } from "./terminal-transcript.ts";

const copy = messages.terminal;

/** The mark's color on a terminal tab: mint while a command runs, rose once the last one failed. */
const MARK: Record<TerminalMark, string> = {
  running: "bg-term-green",
  failed: "bg-term-red",
  idle: "bg-term-dim",
};

const logUrl = (command: { readonly attemptId: string; readonly id: string }) =>
  commandLogUrl(command.attemptId, command.id);

/**
 * The hobs' terminals (#908), with xterm.js in their own chunk, which the Terminal tab loads the
 * first time it opens (STD-REACT-023): a tab per hob, like a terminal app's, with Split to show them side
 * by side, and a search field that finds text in the terminal on show. Picking a tab while split
 * shows that one alone. A log link in a terminal opens only the logs this Task's records name.
 */
export function TerminalPanes({
  terminals,
  live,
  hobs,
  now,
}: {
  terminals: ReadonlyArray<HobCommands>;
  live: LiveOutputs;
  hobs: HobLookup;
  now: Date;
}) {
  const [picked, setPicked] = useState<AgentId | null>(null);
  const [split, setSplit] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const screens = useRef(new Map<AgentId, TerminalHandle>());
  const loaded = useRef(new WeakSet<TerminalHandle>());
  const search = useRef<HTMLInputElement>(null);
  const shown = terminals.find((each) => each.ownerId === picked)?.ownerId ?? terminals[0]?.ownerId ?? "";
  const splitOn = split && terminals.length > 1;
  const logs = new Set(terminals.flatMap((each) => each.commands.map(logUrl)));

  const find = (text: string, direction: "next" | "previous") => {
    const screen = screens.current.get(shown as AgentId);
    if (text === "") {
      screen?.clearFind();
      setResult(null);
    } else {
      screen?.find(text, direction);
    }
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") find(query, event.shiftKey ? "previous" : "next");
    if (event.key === "Escape" && query !== "") {
      // Escape clears the search first; with nothing to clear it goes back, as anywhere else.
      event.preventDefault();
      setQuery("");
      find("", "next");
    }
  };

  return (
    <TerminalFrame
      value={shown}
      onValueChange={(next) => {
        setPicked(next as AgentId);
        setSplit(false);
      }}
      activationMode={splitOn ? "manual" : "automatic"}
      // Its tabs and a couple of rows stay whole in the shortest dock, which scrolls to them.
      className="min-h-24 flex-1"
    >
      <TerminalBar>
        <TerminalTabsList aria-label={copy.terminals}>
          {terminals.map((each) => {
            const mark = terminalMark(each.commands);
            return (
              <TerminalTabsTrigger
                key={each.ownerId}
                value={each.ownerId}
                aria-label={copy.tab({ name: hobs(each.ownerId).name, mark })}
              >
                <span aria-hidden className={cn("size-1.5 rounded-dot", MARK[mark])} />
                {hobs(each.ownerId).name}
              </TerminalTabsTrigger>
            );
          })}
        </TerminalTabsList>
        <span className="flex-1" />
        <TerminalSearchInput
          ref={search}
          aria-label={copy.find}
          placeholder={copy.findPlaceholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            find(event.target.value, "next");
          }}
          onKeyDown={onSearchKey}
        />
        <output aria-live="polite" className="mb-1 px-1.5 py-1 font-mono text-meta text-term-dim">
          {query === "" || result === null
            ? ""
            : result.resultCount === 0
              ? copy.noMatches
              : copy.matches({ index: result.resultIndex, count: result.resultCount })}
        </output>
        {terminals.length > 1 && (
          <TerminalButton
            aria-pressed={splitOn}
            title={splitOn ? copy.unsplitHint : copy.splitHint}
            onClick={() => setSplit(!splitOn)}
          >
            {splitOn ? copy.unsplit : copy.split}
          </TerminalButton>
        )}
      </TerminalBar>
      <div className="flex min-h-0 flex-1">
        {terminals.map((each) => {
          const name = hobs(each.ownerId).name;
          return (
            <TerminalPane key={each.ownerId} value={each.ownerId} split={splitOn}>
              {splitOn && (
                <p className="m-0 border-0 border-b-(length:--edge) border-solid border-term-edge px-2.5 py-1 font-mono text-meta text-term-dim">
                  {name} · {copy.tally(tallyCommands(each.commands))}
                </p>
              )}
              <TerminalScreen
                ref={(handle) => {
                  if (handle === null) return;
                  screens.current.set(each.ownerId, handle);
                  // A search typed while the terminal loaded runs once it is there.
                  if (!loaded.current.has(handle)) {
                    loaded.current.add(handle);
                    if (each.ownerId === shown && query !== "") handle.find(query, "next");
                  }
                  return () => {
                    screens.current.delete(each.ownerId);
                  };
                }}
                label={copy.screen({ name })}
                content={transcript({ name, commands: each.commands, live }, logUrl, now)}
                onLink={(url) => {
                  if (logs.has(url)) window.open(url, "_blank", "noopener,noreferrer");
                }}
                onFind={() => search.current?.focus()}
                onResults={setResult}
              />
            </TerminalPane>
          );
        })}
      </div>
    </TerminalFrame>
  );
}
