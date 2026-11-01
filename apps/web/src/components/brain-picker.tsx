import {
  type Agent,
  type Brain,
  brainLabel,
  RUNTIME_NAMES,
  type RuntimeHealth,
  type RuntimeKind,
  type RuntimeModels,
  sameBrain,
  type Thread,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@hobbots/ui/components/popover";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { modelsQuery, runtimesQuery, threadBrain, useSetBrain } from "../api/queries.ts";
import { modelName, pickedBrain } from "../lib/brains.ts";
import { messages } from "./messages.ts";

const copy = messages.brain;

const TILES: Record<RuntimeKind, { readonly mark: string; readonly className: string }> = {
  "claude-code": { mark: "C", className: "bg-[#e39a74]" },
  codex: { mark: "G", className: "bg-[#8fd3a8]" },
};

/** The runtime's square mark, as the chat header and the picker show it. */
const RuntimeTile = ({ runtime }: { runtime: RuntimeKind }) => (
  <span
    aria-hidden
    className={cn("grid size-5 flex-none place-items-center text-xs font-bold text-ground", TILES[runtime].className)}
  >
    {TILES[runtime].mark}
  </span>
);

const STATE_WORDS: Record<RuntimeHealth["availability"], string> = {
  ready: "ready",
  outdated: "outdated",
  signedOut: "signed out",
  unavailable: "unavailable",
  unverified: "unverified",
};

/** "Claude Code · Sonnet", with the model's own name when the runtime lists it. */
const useBrainLabel = (brain: { readonly runtime: RuntimeKind; readonly model: string | null }) => {
  const models = useQuery(modelsQuery(brain.runtime));
  return brainLabel(brain.runtime, modelName(models.data, brain.model));
};

/** Why a runtime cannot think now, or null when it can. */
const unavailableReason = (health: RuntimeHealth) => {
  if (health.availability === "ready") return null;
  const runtime = RUNTIME_NAMES[health.runtime];
  // Without an adapter the hub reports no version: it has never run the runtime.
  return health.availability === "unavailable" && health.version === null && health.runtime !== "claude-code"
    ? copy.notOnThisHub({ runtime })
    : copy.notReady({ runtime, state: STATE_WORDS[health.availability] });
};

/**
 * The brain chip in the chat header: what the thread thinks with, and whether it is ready. In a
 * thread it opens the picker, which switches the thread's brain from its next reply (ADR 017).
 */
export function BrainPicker({ hob, thread }: { hob: Agent; thread: Thread | undefined }) {
  const brain = threadBrain(hob, thread);
  const label = useBrainLabel(brain);
  const runtimes = useQuery(runtimesQuery);
  const health = runtimes.data?.find((h) => h.runtime === brain.runtime);
  const state = runtimes.isPending ? "checking" : health ? STATE_WORDS[health.availability] : "unknown";
  const chip = (
    <>
      <RuntimeTile runtime={brain.runtime} />
      <span className="font-bold">{label}</span>
      <span className={health?.availability === "ready" ? "text-mint" : "text-lantern"}>{state}</span>
    </>
  );
  const chipClass = "flex flex-none items-center gap-2 border-2 border-line-2 px-2 py-1 text-xs whitespace-nowrap";
  if (thread === undefined) {
    return (
      <span className={chipClass} title={copy.freshPage}>
        {chip}
      </span>
    );
  }
  return <ThreadBrainPicker hob={hob} thread={thread} brain={brain} label={label} chip={chip} chipClass={chipClass} />;
}

function ThreadBrainPicker({
  hob,
  thread,
  brain,
  label,
  chip,
  chipClass,
}: {
  hob: Agent;
  thread: Thread;
  brain: Brain;
  label: string;
  chip: ReactNode;
  chipClass: string;
}) {
  const [open, setOpen] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  const switchId = useId();
  const runtimes = useQuery(runtimesQuery);
  const setBrain = useSetBrain(hob.id, thread.id);
  const hobBrain = { runtime: hob.runtime, model: hob.model, effort: hob.effort };
  const hobLabel = useBrainLabel(hobBrain);
  const pick = (next: Brain | null) =>
    setBrain.mutate(
      { brain: next, ...(makeDefault && next !== null ? { makeDefault: true } : {}) },
      {
        onSuccess: () => {
          setOpen(false);
          setMakeDefault(false);
        },
      },
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(chipClass, "cursor-pointer bg-transparent text-text hover:bg-line")}
          aria-label={copy.trigger({ brain: label })}
        >
          {chip}
          <span aria-hidden className="text-label">
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={copy.title} className="flex flex-col gap-3">
        <span className="lbl text-xs text-label">{copy.title}</span>
        {runtimes.data?.map((health) => (
          <RuntimeChoices
            key={health.runtime}
            health={health}
            current={brain}
            hobEffort={hob.effort}
            pending={setBrain.isPending}
            onPick={pick}
          />
        ))}
        <span className="flex items-center gap-2 text-sm">
          <Switch id={switchId} checked={makeDefault} onCheckedChange={setMakeDefault} />
          <label htmlFor={switchId}>{copy.makeDefault({ name: hob.name })}</label>
        </span>
        {thread.brain !== null && (
          <Button variant="outline" size="xs" disabled={setBrain.isPending} onClick={() => pick(null)}>
            {copy.backToDefault({ name: hob.name, brain: hobLabel })}
          </Button>
        )}
        <span className="text-xs text-label">{copy.scope}</span>
        {setBrain.isError && (
          <span role="alert" className="text-sm text-rose">
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
  hobEffort,
  pending,
  onPick,
}: {
  health: RuntimeHealth;
  current: Brain;
  hobEffort: Agent["effort"];
  pending: boolean;
  onPick: (brain: Brain) => void;
}) {
  const models = useQuery(modelsQuery(health.runtime));
  const reason = unavailableReason(health);
  const choices = modelChoices(models.data, current, health.runtime);
  return (
    <section aria-label={RUNTIME_NAMES[health.runtime]} className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-sm">
        <RuntimeTile runtime={health.runtime} />
        <b className="flex-1">{RUNTIME_NAMES[health.runtime]}</b>
        <span className={reason === null ? "text-xs text-mint" : "text-xs text-lantern"}>
          {STATE_WORDS[health.availability]}
        </span>
      </span>
      {reason !== null ? (
        <span className="text-xs text-lantern">{reason}</span>
      ) : (
        choices.map((choice) => {
          const brain = pickedBrain(models.data, health.runtime, choice.model, hobEffort);
          const selected = current.runtime === health.runtime && current.model === choice.model;
          return (
            <Button
              key={choice.model ?? "default"}
              variant="ghost"
              size="xs"
              aria-pressed={selected}
              disabled={pending}
              className={cn("justify-start", selected && "bg-line")}
              onClick={() => (selected && sameBrain(brain, current) ? undefined : onPick(brain))}
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

/** The runtime's main models, the one the thread thinks with even if it is not main, or its default. */
const modelChoices = (models: RuntimeModels | undefined, current: Brain, runtime: RuntimeKind) => {
  const listed = (models?.models ?? []).filter(
    (m) => m.id !== "default" && (m.main || (current.runtime === runtime && current.model === m.id)),
  );
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
    <p role="note" className="m-0 flex animate-hb-in items-center gap-2.5 text-xs text-label">
      <span aria-hidden className="h-0.5 flex-1 bg-line" />
      <RuntimeTile runtime={brain.runtime} />
      {next ? copy.next({ brain: label }) : copy.now({ brain: label })}
      <span aria-hidden className="h-0.5 flex-1 bg-line" />
    </p>
  );
}
