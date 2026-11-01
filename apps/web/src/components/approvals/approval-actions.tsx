import type { Agent, ApprovalRequest, GrantRule } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { type RefObject, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Decision } from "../../api/approvals.ts";
import { messages } from "../messages.ts";
import { canNarrow, offersAlways, rulesToSave, ruleText, runnerNote } from "./approval-rules.ts";

const copy = messages.approval;

// Stable, so it runs once when its element mounts rather than on every render.
const focusOnMount = (element: HTMLElement | null) => element?.focus();

type Mode = "choose" | "deny" | "always";

/**
 * Allow once, Always for this site and Deny (ADR 015). A high-risk request (`onceOnly`) offers once
 * only and needs the confirmation box ticked first; the hub checks both too (PE-007). Always opens
 * the exact rule it saves, narrowable where the hub allows, before anything is sent. This Quest
 * stays hidden until Quests exist.
 */
export function ApprovalActions({
  approval,
  hob,
  pending,
  onDecide,
}: {
  approval: ApprovalRequest;
  hob: Agent;
  pending: boolean;
  onDecide: (decision: Decision) => void;
}) {
  const [mode, setMode] = useState<Mode>("choose");
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const denyButton = useRef<HTMLButtonElement>(null);
  const alwaysButton = useRef<HTMLButtonElement>(null);
  // The buttons stay enabled while a decision is sent, so they keep keyboard focus; repeats are ignored.
  const send = (decision: Decision) => {
    if (!pending) onDecide(decision);
  };
  // Closing a form brings the buttons back, with focus on the button that opened it.
  const back = (button: RefObject<HTMLButtonElement | null>) => {
    if (pending) return;
    flushSync(() => setMode("choose"));
    button.current?.focus();
  };
  const open = (next: Mode) => () => !pending && setMode(next);
  if (mode === "deny") {
    return (
      <DenyForm
        name={hob.name}
        reason={reason}
        onReason={setReason}
        onDeny={() => send({ decision: "deny", reason })}
        onCancel={() => back(denyButton)}
      />
    );
  }
  if (mode === "always") {
    return (
      <AlwaysForm
        approval={approval}
        name={hob.name}
        onSave={(rules) => send({ decision: "approve", lifetime: "always", rules })}
        onCancel={() => back(alwaysButton)}
      />
    );
  }
  const { onceOnly } = approval;
  const always = offersAlways(approval);
  // A high-risk request explains itself through its check box; any other says why it offers no rule.
  const noRule = !onceOnly && !always;
  return (
    <div className="flex flex-col gap-2">
      {onceOnly && <ConfirmBox name={hob.name} checked={confirmed} onChange={setConfirmed} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="approve"
          disabled={onceOnly && !confirmed}
          aria-disabled={pending}
          onClick={() => send({ decision: "approve", confirmed: onceOnly ? confirmed : undefined })}
        >
          {copy.allowOnce}
        </Button>
        {always && (
          <Button ref={alwaysButton} variant="outline" aria-disabled={pending} onClick={open("always")}>
            {copy.always}
          </Button>
        )}
        <Button ref={denyButton} variant="deny" aria-disabled={pending} onClick={open("deny")}>
          {copy.deny}
        </Button>
      </div>
      {noRule && <p className="m-0 text-xs text-label">{copy.noRule}</p>}
    </div>
  );
}

/** The check box a high-risk action needs before Allow once. */
function ConfirmBox({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-mint"
      />
      {copy.confirm({ name })}
    </label>
  );
}

/**
 * The exact rule Always saves, in words, before it is saved (ADR 015). A folder rule can be narrowed
 * to the files of this action; the decision carries the rules as shown. Escape closes it.
 */
function AlwaysForm({
  approval,
  name,
  onSave,
  onCancel,
}: {
  approval: ApprovalRequest;
  name: string;
  onSave: (rules: ReadonlyArray<GrantRule>) => void;
  onCancel: () => void;
}) {
  const [narrow, setNarrow] = useState(false);
  const rules = rulesToSave(approval, narrow);
  const note = runnerNote(rules, name);
  const headingId = useId();
  return (
    <form
      aria-labelledby={headingId}
      className="flex flex-col gap-2 border-2 border-line-2 bg-deep px-3 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rules);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // The form takes this Escape, so a panel around the card stays open.
        event.stopPropagation();
        onCancel();
      }}
    >
      <span id={headingId} className="lbl text-xs text-label">
        {copy.always}
      </span>
      <p className="m-0 text-sm">{copy.alwaysIntro({ name })}</p>
      <ul aria-label={copy.rulesLabel} className="m-0 flex list-none flex-col gap-1 p-0">
        {rules.map((rule) => (
          <li key={ruleText(rule, name)} className="font-mono text-[13px] break-all text-moonlight">
            {ruleText(rule, name)}
          </li>
        ))}
      </ul>
      {note !== null && <p className="m-0 text-xs text-label">{note}</p>}
      {canNarrow(approval) && <NarrowChoice narrow={narrow} onChange={setNarrow} />}
      <span className="flex flex-wrap gap-2">
        <Button ref={focusOnMount} type="submit" variant="approve">
          {copy.saveRule}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </span>
    </form>
  );
}

/** Whether a folder rule covers every file directly in the folder or only the files of this action. */
function NarrowChoice({ narrow, onChange }: { narrow: boolean; onChange: (narrow: boolean) => void }) {
  const name = useId();
  const options = [
    { value: false, label: copy.wholeFolder },
    { value: true, label: copy.exactFiles },
  ];
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 p-0 text-xs text-label">{copy.narrowLabel}</legend>
      {options.map((option) => (
        <label key={option.label} className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            checked={narrow === option.value}
            onChange={() => onChange(option.value)}
            className="size-4 accent-mint"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

/** The optional reason that goes back to the hob with a Deny. Escape closes it. */
function DenyForm({
  name,
  reason,
  onReason,
  onDeny,
  onCancel,
}: {
  name: string;
  reason: string;
  onReason: (reason: string) => void;
  onDeny: () => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onDeny();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // The form takes this Escape, so a panel around the card stays open.
        event.stopPropagation();
        onCancel();
      }}
    >
      <label htmlFor={inputId} className="text-xs text-label">
        {copy.reasonLabel({ name })}
      </label>
      <span className="flex flex-wrap gap-2">
        <input
          id={inputId}
          ref={focusOnMount}
          value={reason}
          maxLength={2000}
          onChange={(event) => onReason(event.target.value)}
          className="min-w-[200px] flex-1 border-2 border-control bg-deep px-3 py-1.5 text-text"
        />
        <Button type="submit" variant="deny">
          {copy.confirmDeny}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </span>
    </form>
  );
}
