import {
  type Agent,
  type Brain,
  brainLabel,
  type Effort,
  offeredModels,
  RUNTIME_NAMES,
  type RuntimeHealth,
  type RuntimeKind,
  type RuntimeModels,
  sameBrain,
  type Thread,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Popover, PopoverAnchor, PopoverContent } from "@hobbots/ui/components/popover";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { effortWords } from "../../api/first-hob.ts";
import { modelsQuery, runtimesQuery, threadBrain, useSetBrain } from "../../api/queries.ts";
import { modelName, pickedBrain } from "../../lib/brains.ts";
import { PROVIDER_MARKS, RUNTIME_STATE_WORDS } from "../../lib/providers.ts";
import { messages } from "../messages.ts";
import { providerFix } from "./provider-fix.tsx";

const copy = messages.brain;

/** The runtime's square mark, as the chat header and the picker show it. */
export const RuntimeTile = ({ runtime }: { runtime: RuntimeKind }) => (
  <span
    aria-hidden
    className={cn(
      "grid size-5 flex-none place-items-center text-meta font-bold text-provider-ink",
      PROVIDER_MARKS[runtime].tile,
    )}
  >
    {PROVIDER_MARKS[runtime].mark}
  </span>
);

/** "Claude Code · Sonnet", with the model's own name when the runtime lists it. */
export const useBrainLabel = (brain: { readonly runtime: RuntimeKind; readonly model: string | null }) => {
  const models = useQuery(modelsQuery(brain.runtime));
  return brainLabel(brain.runtime, modelName(models.data, brain.model));
};

/** Why a runtime cannot think now and how to fix it, as Settings says it, or null when it can. */
const unavailableReason = (health: RuntimeHealth) => {
  if (health.availability === "ready") return null;
  const runtime = RUNTIME_NAMES[health.runtime];
  return (
    providerFix(health.runtime, health) ??
    (health.availability === "unverified"
      ? copy.notOnThisHub({ runtime })
      : copy.notReady({ runtime, state: RUNTIME_STATE_WORDS[health.availability] }))
  );
};

/** What the thread thinks with, and whether it is ready, as the chat's ⋯ menu names it. */
export const useThreadBrain = (hob: Agent, thread: Thread | undefined) => {
  const brain = threadBrain(hob, thread);
  const modelLabel = useBrainLabel(brain);
  const label = brain.effort === null ? modelLabel : `${modelLabel} · ${effortWords(brain.effort).label}`;
  const runtimes = useQuery(runtimesQuery);
  const health = runtimes.data?.find((h) => h.runtime === brain.runtime);
  const state = runtimes.isPending ? "checking" : health ? RUNTIME_STATE_WORDS[health.availability] : "unknown";
  return { brain, label, state, checking: runtimes.isPending, ready: health?.availability === "ready" };
};

/**
 * The brain picker, opened from the chat's ⋯ menu beside `children`: it switches the thread's brain
 * from its next reply (ADR 017). Closing it hands focus back to the first button in `children`.
 */
export function BrainPicker({
  hob,
  thread,
  open,
  onOpenChange,
  children,
}: {
  hob: Agent;
  thread: Thread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { brain } = useThreadBrain(hob, thread);
  const [makeDefault, setMakeDefault] = useState(false);
  const switchId = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const runtimes = useQuery(runtimesQuery);
  const setBrain = useSetBrain(hob.id, thread.id);
  const hobBrain = { runtime: hob.runtime, model: hob.model, effort: hob.effort };
  const hobLabel = useBrainLabel(hobBrain);
  const pick = (next: Brain | null) =>
    setBrain.mutate(
      { brain: next, ...(makeDefault && next !== null ? { makeDefault: true } : {}) },
      {
        onSuccess: () => {
          onOpenChange(false);
          setMakeDefault(false);
        },
      },
    );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span ref={anchor} className="flex">
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent
        aria-label={copy.title}
        className="flex flex-col gap-3"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          anchor.current?.querySelector("button")?.focus();
        }}
      >
        <span className="lbl text-meta text-label">{copy.title}</span>
        {runtimes.isPending && <RuntimeWaiting runtime={brain.runtime} />}
        {runtimes.data?.map((health) => (
          <RuntimeChoices
            key={health.runtime}
            health={health}
            current={brain}
            keepEffort={brain.effort ?? hob.effort}
            pending={setBrain.isPending}
            makeDefault={makeDefault}
            onPick={pick}
          />
        ))}
        <EffortChoices current={brain} pending={setBrain.isPending} makeDefault={makeDefault} onPick={pick} />
        <span className="flex items-center gap-2 text-ui">
          <Switch id={switchId} checked={makeDefault} onCheckedChange={setMakeDefault} />
          <label htmlFor={switchId}>{copy.makeDefault({ name: hob.name })}</label>
        </span>
        {thread.brain !== null && (
          <Button variant="outline" size="xs" disabled={setBrain.isPending} onClick={() => pick(null)}>
            {copy.backToDefault({ name: hob.name, brain: hobLabel })}
          </Button>
        )}
        <span className="text-meta text-label">{copy.scope}</span>
        {setBrain.isError && (
          <span role="alert" className="text-ui text-rose">
            {copy.failed}
          </span>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One runtime's models, or why it cannot think now. */
function RuntimeChoices({
  health,
  current,
  keepEffort,
  pending,
  makeDefault,
  onPick,
}: {
  health: RuntimeHealth;
  current: Brain;
  keepEffort: Agent["effort"];
  pending: boolean;
  makeDefault: boolean;
  onPick: (brain: Brain) => void;
}) {
  const models = useQuery(modelsQuery(health.runtime));
  const reason = unavailableReason(health);
  const choices = modelChoices(models.data, current, health.runtime);
  return (
    <section aria-label={RUNTIME_NAMES[health.runtime]} className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-ui">
        <RuntimeTile runtime={health.runtime} />
        <b className="flex-1">{RUNTIME_NAMES[health.runtime]}</b>
        <span className={reason === null ? "text-meta text-mint" : "text-meta text-lantern"}>
          {RUNTIME_STATE_WORDS[health.availability]}
        </span>
      </span>
      {reason !== null ? (
        <span className="text-meta text-lantern">{reason}</span>
      ) : models.isPending ? (
        <ChoicesWaiting />
      ) : (
        choices.map((choice) => {
          const brain = pickedBrain(models.data, health.runtime, choice.model, keepEffort);
          const selected = current.runtime === health.runtime && current.model === choice.model;
          return (
            <Button
              key={choice.model ?? "default"}
              variant="ghost"
              size="xs"
              aria-pressed={selected}
              disabled={pending}
              className={cn("justify-start", selected && "bg-line")}
              // Picking the current brain again changes nothing, unless it is to become the hob's default.
              onClick={() => (selected && sameBrain(brain, current) && !makeDefault ? undefined : onPick(brain))}
            >
              <span aria-hidden className="w-3 text-mint">
                {selected ? "●" : ""}
              </span>
              {choice.name}
            </Button>
          );
        })
      )}
    </section>
  );
}

/**
 * A runtime while the hub checks it: its tile and name, a block where its state goes, and its
 * models as name blocks, so the picker does not move when the check lands.
 */
function RuntimeWaiting({ runtime }: { runtime: RuntimeKind }) {
  return (
    <section aria-label={RUNTIME_NAMES[runtime]} aria-busy="true" className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-ui">
        <RuntimeTile runtime={runtime} />
        <b className="flex-1">{RUNTIME_NAMES[runtime]}</b>
        <span className="text-meta">
          <Skeleton width="7ch" />
        </span>
      </span>
      <ChoicesWaiting />
    </section>
  );
}

/** The likely length of each model's name while the runtime lists them. */
const WAITING_MODELS = ["9ch", "7ch", "8ch"] as const;

/** A runtime's model choices as name blocks, in the rows the buttons take. */
function ChoicesWaiting() {
  return (
    <span aria-busy="true" className="flex flex-col">
      {WAITING_MODELS.map((width) => (
        <span key={width} className="flex items-center gap-1.5 px-2 py-1 text-detail">
          <span aria-hidden className="w-3" />
          <Skeleton width={width} />
        </span>
      ))}
    </span>
  );
}

/** The efforts the thread's model takes, to think harder or lighter from the next reply. */
function EffortChoices({
  current,
  pending,
  makeDefault,
  onPick,
}: {
  current: Brain;
  pending: boolean;
  makeDefault: boolean;
  onPick: (brain: Brain) => void;
}) {
  const models = useQuery(modelsQuery(current.runtime));
  const model = models.data?.models.find((m) => m.id === (current.model ?? "default"));
  if (model === undefined) return null;
  if (model.efforts.length === 0) {
    return <span className="text-meta text-label">{copy.noEffort({ model: model.displayName })}</span>;
  }
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="lbl mb-1 p-0 text-meta text-label">{copy.effort}</legend>
      <SegmentedControl
        size="sm"
        aria-label={copy.effort}
        value={current.effort}
        disabled={pending}
        // Picking the current effort again changes nothing, unless it is to become the hob's default.
        onValueChange={(effort: Effort) =>
          effort === current.effort && !makeDefault ? undefined : onPick({ ...current, effort })
        }
      >
        {model.efforts.map((effort: Effort) => (
          <SegmentedControlItem key={effort} value={effort}>
            {effortWords(effort).label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </fieldset>
  );
}

/** The runtime's main models, the one the thread thinks with even if it is not main, or its default. */
const modelChoices = (models: RuntimeModels | undefined, current: Brain, runtime: RuntimeKind) => {
  const listed = offeredModels(models, current.runtime === runtime ? current.model : null);
  return [
    { model: null, name: copy.defaultModel },
    ...listed.map((m) => ({ model: m.id as string | null, name: m.displayName })),
  ];
};

/** Runtimes to continue a reply with: each other one that is ready now. */
export const useOtherReadyRuntimes = (current: RuntimeKind): ReadonlyArray<RuntimeKind> => {
  const runtimes = useQuery(runtimesQuery);
  return (runtimes.data ?? []).flatMap((h) => (h.availability === "ready" && h.runtime !== current ? [h.runtime] : []));
};

/** A line in the transcript where the hob starts thinking with another brain. */
export function BrainSwitchNote({
  brain,
  next = false,
}: {
  brain: Brain | { runtime: RuntimeKind; model: string | null };
  next?: boolean;
}) {
  const label = useBrainLabel(brain);
  return (
    <p role="note" className="m-0 flex animate-hb-in items-center gap-2.5 text-meta text-label">
      <span aria-hidden className="h-0.5 flex-1 bg-line" />
      <RuntimeTile runtime={brain.runtime} />
      {next ? copy.next({ brain: label }) : copy.now({ brain: label })}
      <span aria-hidden className="h-0.5 flex-1 bg-line" />
    </p>
  );
}
