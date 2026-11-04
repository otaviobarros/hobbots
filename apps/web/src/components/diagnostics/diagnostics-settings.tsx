import type { Agent, Quest, QuestId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { diagnosticsNowQuery, diagnosticsQuestsQuery, questTraceQuery } from "../../api/diagnostics.ts";
import { agentsQuery, archivedAgentsQuery } from "../../api/queries.ts";
import { firstLine } from "../../lib/format.ts";
import { formatWhen } from "../../lib/time.ts";
import { DiagnosticsNowView } from "./diagnostics-now.tsx";
import { DiagnosticsReportMaker } from "./diagnostics-report.tsx";
import { messages } from "./messages.ts";
import type { HobName } from "./model.ts";
import { QuestTraceView } from "./quest-trace.tsx";

const copy = messages.follow;

/** Every hob's name, retired ones too, since a Quest outlives the hobs that worked on it. */
const useHobName = (): HobName => {
  const active = useQuery(agentsQuery);
  const retired = useQuery(archivedAgentsQuery);
  const names = new Map<string, string>(
    [...(active.data ?? []), ...(retired.data ?? [])].map((hob: Agent) => [hob.id, hob.name]),
  );
  return (id) => names.get(id) ?? messages.someHob;
};

function QuestPicker({
  quests,
  value,
  hobName,
  onPick,
}: {
  quests: ReadonlyArray<Quest>;
  value: QuestId | null;
  hobName: HobName;
  onPick: (questId: QuestId | null) => void;
}) {
  const id = useId();
  if (quests.length === 0) return <p className="m-0 text-ui text-text-secondary">{copy.none}</p>;
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-ui">
      <span className="text-label">{copy.pick}</span>
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onPick(event.target.value === "" ? null : (event.target.value as QuestId))}
        className="cut max-w-full border-(length:--edge) border-line bg-card px-2 py-1.5 text-text-strong"
      >
        <option value="">{copy.choose}</option>
        {quests.map((quest) => (
          <option key={quest.id} value={quest.id}>
            {copy.option({
              title: firstLine(quest.goal),
              lead: hobName(quest.leadId),
              when: formatWhen(quest.createdAt),
            })}
          </option>
        ))}
      </select>
    </label>
  );
}

function FollowedQuest({ questId, hobName }: { questId: QuestId; hobName: HobName }) {
  const trace = useQuery(questTraceQuery(questId));
  if (trace.isError) {
    const gone = trace.error instanceof ApiError && trace.error.tag === "QuestNotFound";
    return <p className="m-0 text-ui text-rose">{gone ? copy.gone : messages.failed}</p>;
  }
  if (!trace.data) return <p className="m-0 text-ui text-text-secondary">{copy.loading}</p>;
  return <QuestTraceView trace={trace.data} hobName={hobName} />;
}

/**
 * Settings › Diagnostics (ADR 026): what is wrong now, one Quest followed across hobs, Tasks,
 * Attempts and runtimes, and a redacted report you read before you copy or save it.
 */
export function DiagnosticsSettings() {
  const now = useQuery(diagnosticsNowQuery);
  const quests = useQuery(diagnosticsQuestsQuery);
  const hobName = useHobName();
  const [followed, setFollowed] = useState<QuestId | null>(null);
  if (now.isError || quests.isError) return <p className="m-0 text-ui text-rose">{messages.failed}</p>;
  if (!now.data || !quests.data) return null;
  return (
    <>
      <p className="m-0 text-text-secondary">{messages.intro}</p>
      <DiagnosticsNowView now={now.data} hobName={hobName} onFollow={setFollowed} />
      <section aria-label={copy.heading} className="flex flex-col gap-2">
        <span className="lbl pt-2 text-label">{copy.heading}</span>
        <QuestPicker quests={quests.data} value={followed} hobName={hobName} onPick={setFollowed} />
        {followed !== null && <FollowedQuest questId={followed} hobName={hobName} />}
      </section>
      <DiagnosticsReportMaker questId={followed} />
    </>
  );
}
