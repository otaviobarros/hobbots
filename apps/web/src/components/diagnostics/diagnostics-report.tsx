import type { DiagnosticsReport } from "@hobbots/api";
import type { QuestId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { makeReport, reportFileName, reportText } from "../../api/diagnostics.ts";
import { useCopy } from "../../lib/use-copy.ts";
import { messages } from "./messages.ts";

const copy = messages.report;

/** Saves the report where the browser saves downloads, or asks where in the desktop app. */
const save = (report: DiagnosticsReport) => {
  const url = URL.createObjectURL(new Blob([reportText(report)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = reportFileName(report);
  link.click();
  URL.revokeObjectURL(url);
};

const sameInputs = (a: Inputs, b: Inputs) => a.questId === b.questId && a.includeTitles === b.includeTitles;

const failure = (error: unknown): string =>
  error instanceof ApiError && error.tag === "DiagnosticsReportRefused"
    ? copy.refused({ field: String(error.fields.field) })
    : copy.failed;

/** What a report is made from. */
interface Inputs {
  readonly questId: QuestId | null;
  readonly includeTitles: boolean;
}

/** A request and how it ended, kept with the inputs it was made from. */
type Outcome =
  | (Inputs & { readonly state: "making" })
  | (Inputs & { readonly state: "made"; readonly report: DiagnosticsReport })
  | (Inputs & { readonly state: "failed"; readonly error: string });

/**
 * Copy report (ADR 026): the hub makes a redacted report on request and it is shown in full here
 * before you copy or save it. Titles stay out unless you turn them on. Choosing another Quest or
 * changing Include titles drops the report, a refusal and any request still running, so what you
 * copy or save always matches the controls above it.
 */
export function DiagnosticsReportMaker({ questId }: { questId: QuestId | null }) {
  const titlesId = useId();
  const [includeTitles, setIncludeTitles] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, copyReport] = useCopy();
  // Choosing another Quest drops the report and any answer still on its way, even if you come back.
  const [madeFor, setMadeFor] = useState(questId);
  if (madeFor !== questId) {
    setMadeFor(questId);
    setOutcome(null);
  }
  const changeTitles = (next: boolean) => {
    setIncludeTitles(next);
    setOutcome(null);
  };

  const current = outcome !== null && sameInputs(outcome, { questId, includeTitles }) ? outcome : null;
  const making = current?.state === "making";
  const report = current?.state === "made" ? current.report : null;
  const error = current?.state === "failed" ? current.error : null;

  const make = () => {
    const inputs: Inputs = { questId, includeTitles };
    // Only the latest request may land: an older one that answers late is dropped.
    const settle = (next: Outcome) =>
      setOutcome((now) => (now?.state === "making" && sameInputs(now, inputs) ? next : now));
    setOutcome({ ...inputs, state: "making" });
    makeReport(questId, includeTitles).then(
      (made) => settle({ ...inputs, state: "made", report: made }),
      (cause: unknown) => settle({ ...inputs, state: "failed", error: failure(cause) }),
    );
  };

  return (
    <section aria-label={copy.heading} className="flex flex-col gap-2">
      <span className="lbl pt-2 text-label">{copy.heading}</span>
      <p className="m-0 text-sm text-secondary-text">{copy.note}</p>
      <div className="flex items-center gap-3">
        <span className="flex flex-1 flex-col">
          <span id={titlesId}>{copy.includeTitles}</span>
          <span className="text-xs text-secondary-text">{copy.includeTitlesNote}</span>
        </span>
        <Switch aria-labelledby={titlesId} checked={includeTitles} onCheckedChange={changeTitles} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={make} disabled={making}>
          {making ? copy.making : copy.make}
        </Button>
        {questId !== null && <span className="text-xs text-label">{copy.forQuest}</span>}
      </div>
      {error !== null && (
        <p role="alert" className="m-0 text-sm text-rose">
          {error}
        </p>
      )}
      {report !== null && (
        <>
          <section aria-label={copy.view} className="cut max-h-[360px] overflow-auto bg-card p-3">
            <pre className="m-0 font-mono text-xs break-all whitespace-pre-wrap">{reportText(report)}</pre>
          </section>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => copyReport(reportText(report))}>
              {copy.copy[copied]}
            </Button>
            <Button variant="outline" size="sm" onClick={() => save(report)}>
              {copy.save}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
