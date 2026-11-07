import type { DiagnosticsHobSkills, DiagnosticsNow, StalledWork } from "@hobbots/api";
import { type MemoryEngineHealth, RUNTIME_NAMES, type RuntimeHealth } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { formatAgo, formatList } from "../../lib/format.ts";
import { messages } from "./messages.ts";
import { type HobName, memoryNote, recoveryText, runtimeFix, skillsText, stalledText } from "./model.ts";

const copy = messages.now;

function RuntimeRow({ health }: { health: RuntimeHealth }) {
  const fix = runtimeFix(health);
  return (
    <li className="flex flex-col gap-1 border-b-(length:--edge) border-line py-2">
      <span className="flex items-center gap-2">
        <span className="flex-1">{RUNTIME_NAMES[health.runtime]}</span>
        {health.version !== null && <span className="text-meta text-label">{health.version}</span>}
        <Badge variant={health.availability === "ready" ? "working" : "waiting"}>
          {messages.availability[health.availability]}
        </Badge>
      </span>
      {fix !== null && <span className="text-ui text-lantern">{fix}</span>}
    </li>
  );
}

function MemoryRow({ health }: { health: MemoryEngineHealth }) {
  const note = memoryNote(health);
  return (
    <li className="flex flex-col gap-1 border-b-(length:--edge) border-line py-2">
      <span className="flex items-center gap-2">
        <span className="flex-1">{messages.memory.name}</span>
        <span className="text-meta text-label">{health.version}</span>
        <Badge variant={health.state === "running" ? "working" : "waiting"}>
          {messages.memory.state[health.state]}
        </Badge>
      </span>
      {note !== null && <span className="text-ui text-lantern">{note}</span>}
    </li>
  );
}

function StalledRow({
  stalled,
  hobName,
  onFollow,
}: {
  stalled: StalledWork;
  hobName: HobName;
  onFollow: (questId: NonNullable<StalledWork["questId"]>) => void;
}) {
  const { questId } = stalled;
  return (
    <li className="flex flex-wrap items-center gap-2 border-b-(length:--edge) border-line py-2">
      <span className="min-w-0 flex-1 text-ui">{stalledText(stalled, hobName)}</span>
      {questId !== null && (
        <Button variant="outline" size="sm" onClick={() => onFollow(questId)}>
          {copy.followQuest}
        </Button>
      )}
    </li>
  );
}

/** One hob's skills by name and revision, on the runtime it thinks with. */
function SkillsRow({ hob, hobName }: { hob: DiagnosticsHobSkills; hobName: HobName }) {
  return (
    <li className="flex flex-col gap-1 border-b-(length:--edge) border-line py-2">
      <span className="flex items-center gap-2">
        <span className="flex-1">{hobName(hob.agentId)}</span>
        <span className="text-meta text-label">{RUNTIME_NAMES[hob.runtime]}</span>
      </span>
      <span className="text-ui text-text-secondary">{skillsText(hob)}</span>
      {hob.clashes.length > 0 && (
        <span className="text-ui text-lantern">{messages.skills.clash({ names: formatList(hob.clashes) })}</span>
      )}
    </li>
  );
}

/** The Now view: each runtime with its fix, stalled work with what to do, and the last start's recovery. */
export function DiagnosticsNowView({
  now,
  hobName,
  onFollow,
}: {
  now: DiagnosticsNow;
  hobName: HobName;
  onFollow: (questId: NonNullable<StalledWork["questId"]>) => void;
}) {
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-2">
      <span className="lbl pt-2 text-label">{copy.heading}</span>
      {now.workHeld && <p className="m-0 text-ui text-lantern">{copy.held}</p>}
      <ul aria-label={copy.providers} className="m-0 flex list-none flex-col p-0">
        {now.runtimes.map((health) => (
          <RuntimeRow key={health.runtime} health={health} />
        ))}
      </ul>
      {now.memory !== null && (
        <ul aria-label={copy.memory} className="m-0 flex list-none flex-col p-0">
          <MemoryRow health={now.memory} />
        </ul>
      )}
      <ul aria-label={copy.stalled} className="m-0 flex list-none flex-col p-0">
        {now.stalled.length === 0 && <li className="text-ui text-text-secondary">{copy.noStalled}</li>}
        {now.stalled.map((stalled) => (
          <StalledRow
            key={`${stalled.kind}:${stalled.itemId ?? stalled.attemptId}`}
            stalled={stalled}
            hobName={hobName}
            onFollow={onFollow}
          />
        ))}
      </ul>
      <ul aria-label={copy.recovery} className="m-0 flex list-none flex-col p-0">
        {now.recovery.length === 0 && (
          <li className="text-ui text-text-secondary">{copy.recovered({ when: formatAgo(now.startedAt) })}</li>
        )}
        {now.recovery.map((error) => (
          <li key={`${error.step}:${error.attemptId ?? error.taskId}:${error.at}`} className="text-ui text-rose">
            {recoveryText(error)}
          </li>
        ))}
      </ul>
      <span className="lbl pt-2 text-label">{copy.skills}</span>
      <p className="m-0 text-meta text-label">{messages.skills.note}</p>
      <ul aria-label={copy.skills} className="m-0 flex list-none flex-col p-0">
        {now.skills.every((hob) => hob.skills.length === 0) && (
          <li className="text-ui text-text-secondary">{messages.skills.noHobs}</li>
        )}
        {now.skills
          .filter((hob) => hob.skills.length > 0 || hob.clashes.length > 0)
          .map((hob) => (
            <SkillsRow key={hob.agentId} hob={hob} hobName={hobName} />
          ))}
      </ul>
    </section>
  );
}

/** What is wrong now, before the hub answers: the heading, then a still line for each list. */
export function DiagnosticsNowWaiting() {
  return (
    <section aria-label={copy.heading} aria-busy className="flex flex-col gap-2">
      <span className="lbl pt-2 text-label">{copy.heading}</span>
      {["28ch", "22ch", "32ch"].map((width) => (
        <p key={width} className="m-0 text-ui">
          <Skeleton width={width} className="max-w-full" />
        </p>
      ))}
    </section>
  );
}
