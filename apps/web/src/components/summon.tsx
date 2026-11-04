import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.ts";
import {
  type FirstHobDraft,
  gearOf,
  keepSummonDraft,
  keptSummonDraft,
  kindLine,
  LABEL_MAX,
  pickLook,
  reopenDraft,
  rerollName,
  rollLook,
  settleSummonDraft,
  submitDraft,
} from "../api/first-hob.ts";
import { agentsQuery, modelsQuery, runtimesQuery, useCreateHob } from "../api/queries.ts";
import { presetInfo, type RuleAnswer } from "../api/safety.ts";
import { setupQuery } from "../api/setup.ts";
import { openSummonDraft, summonProblem } from "../api/summon.ts";
import { readyProviders } from "../lib/providers.ts";
import {
  Choice,
  ChoresField,
  ColorSwatches,
  draftRolePicker,
  GearPicker,
  HobSummary,
  ModelsBrain,
  NameDice,
  NearbyLooks,
  RolePicker,
  useDraftLook,
  useSettledBrain,
  useSettledRuntime,
} from "./hob-form.tsx";
import { HobSprite } from "./hob-sprite.tsx";
import { messages } from "./messages.ts";
import { ProviderChoices } from "./provider-choices.tsx";
import { Stars } from "./scene.tsx";

const copy = messages.summon;
const shared = messages.onboarding;

const ANSWER: Readonly<Record<RuleAnswer, { text: string; className: string }>> = {
  Ask: { text: copy.answers.Ask, className: "text-mint" },
  Allow: { text: copy.answers.Allow, className: "text-lantern" },
  Never: { text: copy.answers.Never, className: "text-rose" },
};

/**
 * Summon a hob, after onboarding: a role, the chores in the user's words, a seeded look with
 * the role's hat and tool, a name from the dice and what it thinks with. The summon opens the new hob's chat.
 */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export function Summon() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const hobs = useQuery(agentsQuery);
  const runtimes = useQuery(runtimesQuery);
  const setup = useQuery(setupQuery);
  const create = useCreateHob();
  // The route loads the hob list first, so a fresh name avoids the hobs the user already has and a
  // draft whose hob already joined is not brought back.
  const [draft, setDraft] = useState<FirstHobDraft>(() => openSummonDraft(keptSummonDraft(), hobs.data ?? []));
  const models = useQuery(modelsQuery(draft.runtime));
  const [nameRolls, setNameRolls] = useState(0);
  const [lookRolls, setLookRolls] = useState(0);
  const [tried, setTried] = useState(false);
  // A summon that finishes after the user left only joins the hob list; it does not pull them back.
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
    };
  }, []);

  // Leaving and coming back keeps what was chosen, until the hob exists.
  useEffect(() => keepSummonDraft(draft), [draft]);
  useSettledRuntime(readyProviders(runtimes.data), setDraft);
  useSettledBrain(models.data, setDraft);

  const gear = gearOf(draft);
  const look = useDraftLook(draft);
  const health = runtimes.data?.find((r) => r.runtime === draft.runtime);
  const ready = health?.availability === "ready";
  const model = models.data?.models.find((m) => m.id === draft.model);
  const locked = draft.submitted !== null;
  const name = draft.name.trim() || shared.firstHob.yourHob;
  const rejected = create.error instanceof ApiError && create.error.tag === "InvalidHob" ? create.error : undefined;
  const problem = summonProblem(
    draft,
    { pending: runtimes.isPending, failed: runtimes.isError, health },
    model !== undefined,
  );
  const hint = create.isPending
    ? copy.summoning({ name })
    : rejected
      ? copy.rejected({ name, reason: rejected.message })
      : create.isError
        ? shared.ready.failed({ name })
        : problem;

  // Cancel drops the draft; leaving any other way keeps it for next time.
  const cancel = () => {
    left.current = true;
    if (!locked) keepSummonDraft(null);
    if (canGoBack) router.history.back();
    else void navigate({ to: "/hobs" });
  };
  const summon = async (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem || create.isPending) return;
    // Once sent, the hob may exist even when no answer comes back, so the choices lock and a
    // retry repeats the same request; the hub returns the hob it made the first time.
    const sent = submitDraft(draft);
    setDraft(sent);
    try {
      const made = await create.mutateAsync(sent.submitted);
      // The hob exists, so the next Summon starts fresh, even when the user already left. A newer
      // draft started meanwhile belongs to another hob and stays.
      settleSummonDraft(sent.id, null);
      if (!left.current) void navigate({ to: "/hobs/$hobId/new", params: { hobId: made.id }, replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.tag === "InvalidHob") {
        const reopened = reopenDraft(sent);
        setDraft(reopened);
        settleSummonDraft(sent.id, reopened);
      }
    }
  };
  const newLook = () => {
    setDraft((d) => rollLook(d));
    setLookRolls((n) => n + 1);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <form onSubmit={(e) => void summon(e)} className="flex min-h-full flex-col gap-[18px] px-8 py-6">
        <div className="flex items-end gap-4">
          <div className="flex flex-1 flex-col gap-1.5">
            <h1 className="m-0 font-heading text-[32px] font-bold text-moonlight">{copy.heading}</h1>
            <span className="text-text-secondary">{copy.intro}</span>
          </div>
          <Button type="button" variant="outline" onClick={cancel}>
            {copy.cancel}
          </Button>
        </div>

        {/* The choices are disabled once sent: the hob may already exist with exactly these. */}
        <div className="grid min-h-0 flex-1 animate-hb-in grid-cols-[minmax(0,1fr)_430px] gap-7">
          <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0 disabled:opacity-85">
            <legend className="sr-only">{locked ? copy.choresSent({ name }) : copy.whatItDoes}</legend>
            <RolePicker
              {...draftRolePicker(draft, setDraft)}
              legend={<legend className="lbl mb-2 text-moonlight">{shared.firstHob.role}</legend>}
            />

            <ChoresField draft={draft} onChange={setDraft} rows={4} label={copy.chores} className="font-bold" />

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="lbl mb-2 text-moonlight">{copy.worksWhere({ name })}</legend>
              <div className="grid grid-cols-3 gap-2.5">
                <Choice name="hob-place" checked onPick={() => {}} className="flex-col items-start gap-1 p-3">
                  <span className="font-bold">{copy.hub}</span>
                  <span className="text-[13px] leading-snug opacity-85">{copy.hubDetail}</span>
                </Choice>
                <div className="cut flex flex-col items-start gap-1 border-2 border-dashed border-control p-3 text-sm">
                  <span className="flex items-center gap-2 font-bold">
                    {copy.sandbox}
                    <span className="bg-lantern px-1.5 text-xs text-ground">{copy.later}</span>
                  </span>
                  <span className="text-[13px] leading-snug text-text-secondary">{copy.sandboxDetail}</span>
                </div>
              </div>
            </fieldset>

            <section
              aria-label={copy.asksFirst({ name })}
              className="cut flex flex-col gap-2.5 border-2 border-line bg-card px-4 py-3.5"
            >
              <div className="flex items-baseline gap-2.5">
                <span className="lbl flex-1 text-moonlight">{copy.asksFirstBefore({ name })}</span>
                {setup.data && (
                  <span className="text-[13px] text-label">
                    {shared.presetSafety({ preset: presetInfo(setup.data.safetyPreset).label })}
                  </span>
                )}
              </div>
              {setup.data &&
                presetInfo(setup.data.safetyPreset).rules.map(([rule, answer]) => (
                  <div key={rule} className="flex items-center gap-3 text-sm">
                    <span className="flex-1">{rule.toLowerCase()}</span>
                    <span className={cn("text-[13px]", ANSWER[answer].className)}>{ANSWER[answer].text}</span>
                  </div>
                ))}
              <span className="text-[13px] text-text-secondary">
                {copy.safetyNote} <Link to="/settings">{copy.changeInSettings}</Link>
              </span>
            </section>
          </fieldset>

          <section
            aria-label={shared.firstHob.preview}
            className="flex min-w-0 flex-col self-start border-[3px] border-text-strong bg-card"
          >
            <fieldset disabled={locked} className="m-0 flex flex-col border-0 p-0 disabled:opacity-85">
              <legend className="sr-only">{locked ? shared.firstHob.legendSent({ name }) : copy.whoItIs}</legend>
              <div className="relative h-[170px] flex-none overflow-hidden border-b-[3px] border-line-2 bg-panel">
                <Stars count={10} height={100} />
                <div aria-hidden className="absolute inset-x-0 bottom-0 h-9 bg-line" />
                {lookRolls > 0 && (
                  // A puff as the hob changes its look; it fades by itself and never shows under Reduce motion.
                  <span
                    key={lookRolls}
                    aria-hidden
                    className="pointer-events-none absolute bottom-5 left-1/2 -ml-[60px] h-[100px] w-[120px] animate-hb-poof rounded-full bg-text-strong motion-reduce:hidden"
                  />
                )}
                <button
                  type="button"
                  onClick={newLook}
                  aria-label={copy.newLookFor({ name })}
                  title={shared.firstHob.newLookTitle}
                  className="absolute bottom-[22px] left-1/2 -ml-[50px] cursor-pointer border-0 bg-transparent p-0 hover:brightness-110"
                >
                  <span
                    key={[
                      draft.role,
                      draft.hat,
                      draft.tool,
                      draft.lookColor,
                      draft.model,
                      draft.effort,
                      nameRolls,
                    ].join(" ")}
                  >
                    <span className="block animate-hb-hop">
                      <HobSprite hob={{ ...draft, ...gear }} size={100} state="thinking" />
                    </span>
                  </span>
                </button>
                <div className="absolute top-3 left-3 flex flex-col items-start gap-1">
                  <Button type="button" variant="outline" size="xs" onClick={newLook} className="bg-ground">
                    {shared.firstHob.newLook}
                  </Button>
                  <span aria-live="polite" className="max-w-[230px] text-[11px] text-label">
                    {shared.firstHob.look({ seed: draft.lookSeed, recipe: look.recipe })}
                  </span>
                </div>
                <div className="absolute top-3 right-3">
                  <NearbyLooks
                    draft={draft}
                    onPick={(seed) => {
                      setDraft((d) => pickLook(d, seed));
                      setLookRolls((n) => n + 1);
                    }}
                    count={4}
                    tile={34}
                    className="grid grid-cols-2 gap-[5px]"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2.5 px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <label htmlFor="hob-name" className="sr-only">
                    {copy.hobName}
                  </label>
                  <input
                    id="hob-name"
                    value={draft.name}
                    maxLength={LABEL_MAX}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDraft((d) => ({ ...d, name: value, named: true }));
                    }}
                    className="w-[130px] border-0 border-b-2 border-dashed border-control bg-transparent px-0 py-0.5 font-heading text-[26px] font-bold text-text-strong"
                  />
                  <NameDice
                    size={18}
                    rolls={nameRolls}
                    onRoll={() => {
                      setDraft(rerollName);
                      setNameRolls((n) => n + 1);
                    }}
                    className="size-9"
                  />
                  <span className="min-w-0 truncate text-text-secondary">{kindLine(draft)}</span>
                </div>

                <fieldset className="m-0 flex items-center gap-2.5 border-0 p-0">
                  <legend className="sr-only">{shared.firstHob.colors}</legend>
                  <span aria-hidden className="w-[50px] text-sm text-label">
                    {shared.firstHob.colors}
                  </span>
                  <ColorSwatches
                    value={draft.lookColor}
                    onPick={(lookColor) => setDraft((d) => ({ ...d, lookColor }))}
                    className="flex gap-[5px]"
                  />
                </fieldset>

                <GearPicker draft={draft} onChange={setDraft} />

                <div className="flex flex-col gap-1.5 border-t-2 border-line pt-[9px]">
                  <span className="text-sm text-label">{shared.firstHob.thinksWith}</span>
                  {runtimes.isPending ? (
                    <span className="py-1 text-sm text-lantern">
                      {messages.summon.checkingProviders} <span className="animate-hb-blink">•••</span>
                    </span>
                  ) : !runtimes.data ? (
                    <span role="alert" className="flex items-center gap-3 text-sm text-rose">
                      {messages.summon.checkFailed}
                      <CheckAgain checking={runtimes.isFetching} onCheck={() => void runtimes.refetch()} />
                    </span>
                  ) : (
                    <>
                      <ProviderChoices
                        runtimes={runtimes.data}
                        draft={draft}
                        onChange={setDraft}
                        chipClassName="px-[9px] py-1 text-[13px]"
                      />
                      {ready && <ModelsBrain models={models} draft={draft} onChange={setDraft} />}
                    </>
                  )}
                </div>

                <div className="flex gap-3 border-t-2 border-line pt-[9px] text-sm">
                  <span className="w-[92px] flex-none text-label">{copy.runs}</span>
                  <span className="flex-1 leading-snug">{copy.runsWhen}</span>
                </div>
              </div>
            </fieldset>

            <div className="mt-auto flex flex-col gap-2 px-4 pb-4">
              <HobSummary draft={draft} model={model} className="pb-1" />
              <Button
                type="submit"
                aria-disabled={problem !== undefined || create.isPending}
                aria-describedby="summon-hint"
                className={cn(
                  "w-full",
                  problem && "cursor-not-allowed bg-line-2 text-label shadow-[0_4px_0_#22203f] hover:bg-line-2",
                )}
              >
                {shared.ready.summon({ name })}
              </Button>
              <span
                id="summon-hint"
                role={create.isError ? "alert" : undefined}
                className={cn(
                  "min-h-5 text-center text-sm",
                  create.isError ? "text-rose" : problem && tried ? "text-lantern" : "text-text-secondary",
                )}
              >
                {hint}
              </span>
            </div>
          </section>
        </div>
      </form>
    </main>
  );
}

function CheckAgain({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <Button type="button" variant="outline" size="xs" onClick={onCheck} disabled={checking}>
      {checking ? messages.summon.checking : messages.summon.checkAgain}
    </Button>
  );
}
