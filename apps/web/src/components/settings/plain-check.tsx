import { openBlocker } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { WaitNote } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useWaitStage } from "@hobbots/ui/lib/wait-stage";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useBlockersQuery } from "../../api/blockers.ts";
import { connectionBridge } from "../../api/connected-desktop.ts";
import { makeReport } from "../../api/diagnostics.ts";
import { githubStatusQuery } from "../../api/github.ts";
import { runtimesQuery } from "../../api/queries.ts";
import { remoteAccessQuery } from "../../api/remote-access.ts";
import { setupQuery } from "../../api/setup.ts";
import { saveReport } from "../diagnostics/diagnostics-report.tsx";
import { messages } from "./messages.ts";
import { type CheckLine, type CheckSource, type CheckTone, checkLines } from "./plain-check-model.ts";

const copy = messages.check;

/** Each outcome's mark and color, as the overview marks its cards. */
const TONES: Readonly<Record<CheckTone, { readonly glyph: string; readonly color: string }>> = {
  ok: { glyph: "✓", color: "text-mint" },
  off: { glyph: "○", color: "text-label" },
  warn: { glyph: "!", color: "text-lantern" },
  broken: { glyph: "!", color: "text-rose" },
};

/** What the check reads, and a way to read it all again. */
const useCheck = () => {
  const runtimes = useQuery(runtimesQuery);
  const setup = useQuery(setupQuery);
  const github = useQuery(githubStatusQuery);
  // A connected desktop's hub sets remote access, so this Mac does not ask for it.
  const remote = useQuery({ ...remoteAccessQuery, enabled: connectionBridge === undefined });
  const blockers = useBlockersQuery();
  const lines = checkLines({
    runtimes: runtimes.data,
    connected: setup.data?.connectedProviders,
    folders: setup.data?.approvedFolders.length,
    github: github.data,
    remote: connectionBridge === undefined ? remote.data : null,
    stuck: blockers.data?.filter((item) => openBlocker(item) !== undefined).length,
  });
  const local = connectionBridge === undefined;
  const sources: Readonly<Record<CheckSource, { readonly isFetching: boolean; readonly refetch: () => unknown }>> = {
    runtimes,
    setup,
    github,
    remote,
    blockers,
  };
  const reads = [runtimes, setup, github, blockers, ...(local ? [remote] : [])];
  return {
    lines,
    checking: reads.some((read) => read.isFetching),
    fetching: (source: CheckSource) => (source !== "remote" || local) && sources[source].isFetching,
    run: () => Promise.all(reads.map((read) => read.refetch())),
  };
};

/** One line: ○, its name and "Checking…" while its read runs, then ✓ or ! with what was found. */
function Line({ line, checking }: { line: CheckLine; checking: boolean }) {
  if (checking) {
    return (
      <li className="flex items-baseline gap-2">
        <span aria-hidden className={cn("w-4 flex-none text-center font-bold", TONES.off.color)}>
          {TONES.off.glyph}
        </span>
        <span className="min-w-0 flex-1">
          {line.name} <span className="text-text-secondary">{copy.lineChecking}</span>
        </span>
      </li>
    );
  }
  const tone = TONES[line.tone];
  return (
    <li className="flex items-baseline gap-2">
      <span aria-hidden className={cn("w-4 flex-none text-center font-bold", tone.color)}>
        {tone.glyph}
      </span>
      <span className="min-w-0 flex-1">
        {line.text}
        {line.inbox && (
          <>
            {" "}
            <Link to="/inbox" search={{ tab: "needs" }} className="text-link underline underline-offset-2">
              {copy.openInbox}
            </Link>
          </>
        )}
      </span>
    </li>
  );
}

/** Save a report for support: the redacted report, without titles, saved where downloads go. */
function SaveReport() {
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const save = () => {
    setState("saving");
    makeReport(null, false).then(
      (report) => {
        saveReport(report);
        setState("idle");
      },
      () => setState("failed"),
    );
  };
  return (
    <>
      <Button variant="ghost" onClick={save} disabled={state === "saving"}>
        {state === "saving" ? copy.saving : copy.save}
      </Button>
      {state === "failed" && (
        <p role="alert" className="m-0 basis-full text-ui text-rose">
          {copy.saveFailed}
        </p>
      )}
    </>
  );
}

/**
 * Settings › Help and about leads with this: check that everything works, in plain words, from the
 * hub's own records, with stuck work counted as the Inbox counts it. Save a report for support
 * makes the redacted diagnostics report; its options and Follow a quest sit behind Technical details.
 */
export function PlainCheck() {
  const check = useCheck();
  const [checked, setChecked] = useState(false);
  const wait = useWaitStage(checked && check.checking);
  const run = () => {
    setChecked(true);
    void check.run();
  };
  return (
    <section aria-label={copy.title} className="flex flex-col gap-2.5 rounded-card bg-card p-4">
      <strong className="text-text-strong">{copy.title}</strong>
      <p className="m-0 text-ui text-text-secondary">{copy.intro}</p>
      {checked && (
        <ul
          aria-label={copy.title}
          aria-busy={check.checking}
          className="m-0 flex animate-hb-in list-none flex-col gap-1 p-0 text-ui"
        >
          {check.lines.map((line) => (
            <Line key={line.key} line={line} checking={check.fetching(line.source)} />
          ))}
        </ul>
      )}
      {checked && check.checking && (
        <WaitNote
          wait={wait}
          detail={messages.wait.everything}
          outside={{ note: messages.wait.everythingSlow, retryLabel: messages.wait.tryAgain, onRetry: run }}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={run} disabled={check.checking && checked}>
          {check.checking && checked ? copy.checking : checked ? copy.again : copy.run}
        </Button>
        <SaveReport />
      </div>
    </section>
  );
}
