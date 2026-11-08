import type { CharmOperationId, PolicyDecision, SummoningScope } from "@hobbots/domain";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { type ReactNode, useId } from "react";
import { fieldWords, messages } from "./messages.ts";
import { PickedHobs } from "./picked-hobs.tsx";
import { answersFor, type SummoningEdit, type SummoningView, shownAnswer, shownGroups } from "./summoning-model.ts";
import { SUMMONING_ROW } from "./summoning-row.ts";

/**
 * The Summoning Charm's settings (ADR 034), the same on a hob's Charms tab and in "Summoning for
 * every hob": who the hob may manage, then Allow, Ask or Never per field. Each change is saved at
 * once through `onEdit`.
 */
export function SummoningSettings({
  name,
  self,
  view,
  pending,
  labels,
  onEdit,
  between,
}: {
  /** The hob the settings are for, or the words for every hob. */
  name: string;
  /** The hob's own id, left out of the hobs it may pick, or null in Settings. */
  self: string | null;
  view: SummoningView;
  pending: boolean;
  labels: { readonly who: string; readonly mayDo: string; readonly note: string };
  onEdit: (edit: SummoningEdit) => void;
  /** What goes between the scope and the fields, such as the counts against the caps. */
  between?: ReactNode;
}) {
  const scope = (next: SummoningScope) => onEdit({ _tag: "Scope", scope: next });
  return (
    <>
      <Section label={labels.who}>
        <ScopeSwitch
          label={messages.scope.summoned}
          note={messages.scope.summonedNote({ name })}
          checked={view.scope.summoned}
          pending={pending}
          onChange={(summoned) => scope({ ...view.scope, summoned })}
        />
        <PickedHobs name={name} self={self} scope={view.scope} pending={pending} onChange={scope} />
        <ScopeSwitch
          label={messages.scope.self}
          note={messages.scope.selfNote}
          checked={view.scope.self}
          pending={pending}
          onChange={(on) => scope({ ...view.scope, self: on })}
        />
      </Section>
      {between}
      <Section label={labels.mayDo}>
        {shownGroups(view.scope).map((group) => (
          <div key={group.id} className="flex flex-col gap-1.5">
            <h4 className="m-0 pt-1.5 text-meta font-bold text-label">
              {group.id === "self" ? messages.groups.self({ name }) : messages.groups[group.id]}
            </h4>
            {group.operations.map((operation) => (
              <FieldRow
                key={operation}
                operation={operation}
                answer={shownAnswer(view, operation)}
                pending={pending}
                onPick={(answer) => onEdit({ _tag: "Answer", operation, answer })}
              />
            ))}
          </div>
        ))}
        <span className="text-detail text-label">{labels.note}</span>
      </Section>
    </>
  );
}

/** A labelled part of the settings, with the rule after its label as the Charm cards draw it. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3
        id={headingId}
        className="lbl m-0 flex items-center gap-2 text-label after:h-px after:flex-1 after:bg-line after:content-['']"
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

/** One of the scope's switches, with its label and what it lets the hob do. */
function ScopeSwitch({
  label,
  note,
  checked,
  pending,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  pending: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const noteId = useId();
  return (
    <div className={cn(SUMMONING_ROW, "items-center")}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={labelId} className="text-text-strong">
          {label}
        </span>
        <span id={noteId} className="text-detail text-text-secondary">
          {note}
        </span>
      </span>
      <Switch
        aria-labelledby={labelId}
        aria-describedby={noteId}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** One field: what it covers and Allow, Ask or Never, or asking once or Never for retiring. */
function FieldRow({
  operation,
  answer,
  pending,
  onPick,
}: {
  operation: CharmOperationId;
  answer: PolicyDecision;
  pending: boolean;
  onPick: (answer: PolicyDecision) => void;
}) {
  const words = fieldWords(operation);
  const noteId = useId();
  const offered = answersFor(operation);
  return (
    <div className={cn(SUMMONING_ROW, "items-center")}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-text-strong">{words.label}</span>
        {words.note !== "" && (
          <span id={noteId} className="text-detail text-text-secondary">
            {words.note}
          </span>
        )}
      </span>
      <SegmentedControl
        size="sm"
        value={answer}
        onValueChange={(next: PolicyDecision) => {
          if (next !== answer) onPick(next);
        }}
        aria-label={words.label}
        aria-describedby={words.note === "" ? undefined : noteId}
        className="w-[210px] flex-none"
      >
        {offered.map((option) => (
          <SegmentedControlItem key={option} value={option} disabled={pending} className="flex-1">
            {offered.length === 2 && option === "allow" ? messages.answers.once : messages.answers[option]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}
