import type { DiagnosticsReport } from "@hobbots/api";
import type { QuestId } from "@hobbots/domain";
import { queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

/** Settings › Diagnostics (ADR 026): every read is fresh when the section opens, never followed live. */
const diagnosticsKey = ["diagnostics"] as const;

/** What is wrong now: runtimes, stalled work, the last start's recovery errors and the hold. */
export const diagnosticsNowQuery = queryOptions({
  queryKey: [...diagnosticsKey, "now"] as const,
  queryFn: () => call((c) => c.diagnostics.now()),
});

/** The Quests you can follow, newest first. */
export const diagnosticsQuestsQuery = queryOptions({
  queryKey: [...diagnosticsKey, "quests"] as const,
  queryFn: () => call((c) => c.diagnostics.quests()),
});

/** One Quest followed across hobs, Tasks, Attempts and runtimes. */
export const questTraceQuery = (questId: QuestId) =>
  queryOptions({
    queryKey: [...diagnosticsKey, "trace", questId] as const,
    queryFn: () => call((c) => c.diagnostics.trace({ params: { questId } })),
  });

/** A redacted report, made by the hub on request; the hub never sends it anywhere. */
export const makeReport = (questId: QuestId | null, includeTitles: boolean): Promise<DiagnosticsReport> =>
  call((c) =>
    c.diagnostics.report({
      query: { ...(questId === null ? {} : { questId }), titles: includeTitles ? "true" : "false" },
    }),
  );

/** The report as you read, copy and save it: indented JSON. */
export const reportText = (report: DiagnosticsReport): string => `${JSON.stringify(report, null, 2)}\n`;

/** `hobbots-diagnostics-<date>.json`, with the date the report was made. */
export const reportFileName = (report: Pick<DiagnosticsReport, "createdAt">): string =>
  `hobbots-diagnostics-${report.createdAt.slice(0, 10)}.json`;
