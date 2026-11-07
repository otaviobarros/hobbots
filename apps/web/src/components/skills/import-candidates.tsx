import type { SkillCandidate } from "@hobbots/api";
import { cn } from "@hobbots/ui/lib/utils";
import { messages } from "./messages.ts";
import { droppedLine } from "./skill-flags.tsx";
import { importable, skillTitle } from "./skills-model.ts";
import { SkillChip, SkillsIcon } from "./skills-parts.tsx";

const copy = messages;

const checkLine = (candidate: SkillCandidate): { readonly text: string; readonly tone: "ok" | "label" | "bad" } => {
  if (candidate.refusal !== null) {
    const rule = copy.checks[candidate.refusal.check];
    const path = candidate.refusal.path;
    return { text: path === null ? rule : copy.import.refusedRule({ path, rule }), tone: "bad" };
  }
  if (candidate.existing?.number != null) {
    return {
      text: copy.import.alreadyLine({ rev: copy.revision({ number: candidate.existing.number }) }),
      tone: "label",
    };
  }
  if (candidate.existing !== null) return { text: copy.import.newRevisionLine, tone: "label" };
  return { text: copy.import.passedNoSize, tone: "ok" };
};

/** One skill a source holds: pick it to import, or see why it cannot be. */
function Candidate({
  candidate,
  picked,
  onToggle,
}: {
  candidate: SkillCandidate;
  picked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const can = importable(candidate);
  const line = checkLine(candidate);
  const title = candidate.name === null ? candidate.folder || copy.wholeSkill : skillTitle(candidate.name);
  const dropped = droppedLine(candidate.dropped);
  return (
    <li className="flex items-start gap-3 bg-card px-3.5 py-3">
      <input
        type="checkbox"
        className="mt-1 size-4 flex-none accent-(--color-mint-deep)"
        aria-label={copy.import.pick({ name: title })}
        checked={can && picked}
        disabled={!can}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold text-text-strong">{title}</span>
          {candidate.existing?.number != null && <SkillChip tone="later">{copy.import.already}</SkillChip>}
          {candidate.existing !== null && candidate.existing.number === null && (
            <SkillChip tone="waiting">{copy.import.newRevision}</SkillChip>
          )}
          {candidate.flags.length > 0 && <SkillChip tone="needs">{copy.import.flagged}</SkillChip>}
        </span>
        {candidate.description !== null && (
          <span className="text-detail text-text-secondary">{candidate.description}</span>
        )}
        <span
          className={cn(
            "text-meta",
            line.tone === "ok" && "text-mint",
            line.tone === "label" && "text-label",
            line.tone === "bad" && "text-rose",
          )}
        >
          {line.text}
        </span>
        {dropped !== null && <span className="text-meta text-label">{dropped}</span>}
      </span>
    </li>
  );
}

/** Every skill a scan found, with a box to pick each one that can be imported. */
export function ImportCandidates({
  candidates,
  picked,
  onToggle,
}: {
  candidates: ReadonlyArray<SkillCandidate>;
  picked: ReadonlySet<string>;
  onToggle: (folder: string, on: boolean) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col overflow-hidden rounded-card p-0 [&>li+li]:border-t [&>li+li]:border-line">
      {candidates.map((candidate) => (
        <Candidate
          key={candidate.folder}
          candidate={candidate}
          picked={picked.has(candidate.folder)}
          onToggle={(on) => onToggle(candidate.folder, on)}
        />
      ))}
    </ul>
  );
}

/** A scan where nothing can be imported because every skill failed a check: each file and its rule. */
export function ImportRefused({ candidates }: { candidates: ReadonlyArray<SkillCandidate> }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-card bg-[color-mix(in_srgb,var(--color-rose)_10%,var(--color-card))] px-3.5 py-3 text-ui text-text-strong"
    >
      <span className="mt-0.5 text-rose">
        <SkillsIcon name="flag" />
      </span>
      <span className="flex min-w-0 flex-col gap-2">
        <b className="font-semibold">{copy.import.refusedTitle}</b>
        <span className="text-detail text-text-secondary">{copy.import.refusedBody}</span>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {candidates.map((candidate) => (
            <li key={candidate.folder} className="flex flex-col gap-0.5 rounded-control bg-card px-2.5 py-2">
              <code className="self-start font-mono text-detail">
                {candidate.refusal?.path ?? (candidate.folder || copy.wholeSkill)}
              </code>
              <span className="text-detail">
                {candidate.refusal === null ? "" : copy.checks[candidate.refusal.check]}
              </span>
            </li>
          ))}
        </ul>
        <span className="text-detail text-text-secondary">{copy.import.refusedFix}</span>
      </span>
    </div>
  );
}
