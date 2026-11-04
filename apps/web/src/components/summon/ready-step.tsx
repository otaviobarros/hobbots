import { lengthChoice, type RuntimeHealth, type RuntimeModels, voiceChoice } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton, WaitNote } from "@hobbots/ui/components/skeleton";
import { useWaitStage } from "@hobbots/ui/lib/wait-stage";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type FirstHobDraft, roleTitleOf, thinksWith } from "../../api/first-hob.ts";
import type { PresetInfo } from "../../api/safety.ts";
import { ModelsBrain } from "../hob-form/hob-form.tsx";
import { messages as shared } from "../messages.ts";
import { messages } from "./messages.ts";
import { ProviderCards, ProviderCardsWaiting } from "./provider-cards.tsx";
import { SignedOutCard } from "./signed-out-card.tsx";
import type { SummonStep } from "./summon-model.ts";

const copy = messages.ready;

type Update = (update: (draft: FirstHobDraft) => FirstHobDraft) => void;

/**
 * Step 3, ready: the choices as plain sentences, each with Change, then the AI it thinks with, with
 * the model and effort one click further. Safety follows Settings and is never chosen here.
 */
export function ReadyStep({
  draft,
  onChange,
  name,
  preset,
  presetPending,
  runtimes,
  models,
  signedOut,
  onGo,
}: {
  draft: FirstHobDraft;
  onChange: Update;
  name: string;
  preset: PresetInfo | undefined;
  /** Whether the safety level is still being read, so its row holds its place. */
  presetPending: boolean;
  runtimes: UseQueryResult<ReadonlyArray<RuntimeHealth>>;
  models: UseQueryResult<RuntimeModels>;
  /** The signed-out AI the hob would think with, which Ready leads with until it is signed in. */
  signedOut?: RuntimeHealth | undefined;
  onGo: (step: SummonStep) => void;
}) {
  const voice = voiceChoice(draft.voice).title;
  const length = lengthChoice(draft.length).title;
  return (
    <div className="flex flex-col gap-3.5">
      {signedOut && <SignedOutCard health={signedOut} name={name} />}
      <dl aria-label={copy.summary({ name })} className="m-0 flex flex-col rounded-card bg-card px-4 py-1.5">
        <Row
          term={copy.helpsWith}
          value={roleTitleOf(draft)}
          note={draft.chores.trim() || copy.noChores}
          action={<ChangeButton label={copy.changeRole({ name })} onClick={() => onGo("role")} />}
        />
        <Row
          term={copy.talks}
          value={copy.talkLine({ voice, length })}
          note={copy.soundsLike({ sample: messages.look.samples[draft.voice] })}
          action={<ChangeButton label={copy.changeTalk({ name })} onClick={() => onGo("look")} />}
        />
        {(preset || presetPending) && (
          <Row
            term={copy.canDo}
            value={preset ? copy.preset({ preset: preset.label }) : null}
            note={preset?.note ?? null}
            action={
              <Link
                to="/settings/$section"
                params={{ section: "safety" }}
                className="text-detail whitespace-nowrap text-link underline underline-offset-3"
              >
                {copy.changeInSettings}
              </Link>
            }
          />
        )}
        <Row term={copy.worksOn} value={copy.thisComputer} note={copy.thisComputerNote} last />
      </dl>

      <section aria-label={copy.ai} className="flex flex-col gap-2 rounded-card bg-deep p-3.5">
        <span aria-hidden className="lbl text-label">
          {copy.ai}
        </span>
        <Thinks draft={draft} onChange={onChange} runtimes={runtimes} models={models} />
      </section>
      <span className="text-detail text-label">{copy.later}</span>
    </div>
  );
}

function Row({
  term,
  value,
  note,
  action,
  last = false,
}: {
  term: string;
  /** The row's value, or null while it loads. */
  value: string | null;
  /** The line under the value; null holds its place while it loads. */
  note?: string | null | undefined;
  action?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`flex items-start gap-4 py-3 max-[720px]:flex-wrap ${last ? "" : "border-b border-line"}`}>
      <dt className="lbl w-[140px] flex-none pt-0.5 text-label">{term}</dt>
      <dd className="m-0 flex min-w-0 flex-1 flex-col">
        <strong title={value ?? undefined} className="truncate">
          {value ?? <Skeleton width="24ch" surface="card" />}
        </strong>
        {note === null ? (
          <span className="text-detail">
            <Skeleton width="36ch" surface="card" />
          </span>
        ) : (
          note && <span className="line-clamp-2 text-detail text-text-secondary">{note}</span>
        )}
      </dd>
      {action}
    </div>
  );
}

function ChangeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="xs" onClick={onClick} aria-label={label}>
      {copy.change}
    </Button>
  );
}

/** The AI cards, then the model and effort behind one click, with the wait and the failure before them. */
function Thinks({
  draft,
  onChange,
  runtimes,
  models,
}: {
  draft: FirstHobDraft;
  onChange: Update;
  runtimes: UseQueryResult<ReadonlyArray<RuntimeHealth>>;
  models: UseQueryResult<RuntimeModels>;
}) {
  const [brainOpen, setBrainOpen] = useState(false);
  const wait = useWaitStage(runtimes.isPending);
  if (runtimes.isPending) {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <ProviderCardsWaiting />
        <span className="flex flex-wrap items-center gap-3">
          <ConnectAnother />
        </span>
        <WaitNote
          wait={wait}
          detail={shared.summon.waitingProviders}
          outside={{
            note: shared.summon.checkSlow,
            retryLabel: shared.summon.tryAgain,
            onRetry: () => void runtimes.refetch(),
          }}
        />
      </div>
    );
  }
  if (!runtimes.data) {
    return (
      <span role="alert" className="flex items-center gap-3 text-ui text-rose">
        {shared.summon.checkFailed}
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void runtimes.refetch()}
          disabled={runtimes.isFetching}
        >
          {runtimes.isFetching ? shared.summon.checking : shared.summon.checkAgain}
        </Button>
      </span>
    );
  }
  const ready = runtimes.data.some((r) => r.runtime === draft.runtime && r.availability === "ready");
  const model = models.data?.models.find((m) => m.id === draft.model);
  const set = (next: FirstHobDraft) => onChange(() => next);
  return (
    <>
      <ProviderCards runtimes={runtimes.data} draft={draft} onChange={set} />
      <span className="flex flex-wrap items-center gap-3">
        <ConnectAnother />
        {ready && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={brainOpen}
            onClick={() => setBrainOpen(!brainOpen)}
          >
            {brainOpen ? copy.brainOpen : copy.brainClosed({ brain: thinksWith(draft, model) })}
          </Button>
        )}
      </span>
      {ready && brainOpen && (
        <div className="flex animate-hb-in flex-col gap-2">
          <ModelsBrain models={models} draft={draft} onChange={set} />
        </div>
      )}
    </>
  );
}

/** The way to Settings › Connections, beside the brain's button. */
function ConnectAnother() {
  return (
    <Link
      to="/settings/$section"
      params={{ section: "connections" }}
      className="flex-1 text-detail text-link underline underline-offset-3"
    >
      {copy.connectAnother}
    </Link>
  );
}
