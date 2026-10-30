import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client.ts";
import {
  draftProblem,
  kindLine,
  LABEL_MAX,
  reopenDraft,
  rollLook,
  rollName,
  settleBrain,
  submitDraft,
} from "../api/first-hob.ts";
import { agentsQuery, modelsQuery, runtimesQuery, useCreateHob } from "../api/queries.ts";
import { presetInfo, type RuleAnswer } from "../api/safety.ts";
import { setupQuery } from "../api/setup.ts";
import {
  CHORES_MAX,
  newSummonDraft,
  pickKind,
  providerNotice,
  type SummonDraft,
  summonPayload,
} from "../api/summon.ts";
import { hobLook } from "../art/look.ts";
import { Brain, Choice, ColorSwatches, CraftChoices, NameDice } from "./hob-form.tsx";
import { HobSprite } from "./hob-sprite.tsx";
import { Stars } from "./scene.tsx";

const ANSWER: Readonly<Record<RuleAnswer, { text: string; className: string }>> = {
  Ask: { text: "Asks first", className: "text-mint" },
  Allow: { text: "Allowed", className: "text-lantern" },
  Never: { text: "Never", className: "text-rose" },
};

/**
 * Summon a hob, after onboarding: the chores in the user's words or a kind to start from, a
 * seeded look, a name from the dice and what it thinks with. The summon opens the new hob's chat.
 */
export function Summon() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const hobs = useQuery(agentsQuery);
  const runtimes = useQuery(runtimesQuery);
  const models = useQuery(modelsQuery("claude-code"));
  const setup = useQuery(setupQuery);
  const create = useCreateHob();
  // The route loads the hob list first, so the first name avoids the hobs the user already has.
  const [draft, setDraft] = useState<SummonDraft>(() => newSummonDraft(hobs.data?.map((h) => h.name) ?? []));
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

  useEffect(() => {
    if (models.data) setDraft((d) => (d.submitted ? d : settleBrain(d, models.data)));
  }, [models.data]);

  const look = useMemo(() => hobLook(draft.lookSeed, draft.lookColor), [draft.lookSeed, draft.lookColor]);
  const claude = runtimes.data?.find((r) => r.runtime === "claude-code");
  const notice = providerNotice(claude);
  const connected = notice === undefined;
  const model = models.data?.models.find((m) => m.id === draft.model);
  const locked = draft.submitted !== null;
  const name = draft.name.trim() || "your hob";
  const rejected = create.error instanceof ApiError && create.error.tag === "InvalidHob" ? create.error : undefined;
  const problem = locked
    ? undefined
    : (draftProblem(draft) ??
      (runtimes.data && !connected
        ? `Fix Claude Code in Settings to summon ${name}`
        : model
          ? undefined
          : "Waiting for Claude Code's models"));
  const hint = create.isPending
    ? `Summoning ${name}… If you leave now, ${name} still joins your hobs.`
    : rejected
      ? `Hobbots could not create ${name}: ${rejected.message}.`
      : create.isError
        ? `Hobbots could not finish summoning ${name}. Try again in a moment.`
        : problem;

  const cancel = () => {
    left.current = true;
    if (canGoBack) router.history.back();
    else void navigate({ to: "/hobs" });
  };
  const summon = async (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem || create.isPending) return;
    // Once sent, the hob may exist even when no answer comes back, so the choices lock and a
    // retry repeats the same request; the hub returns the hob it made the first time.
    const sent = submitDraft(draft, summonPayload);
    setDraft(sent);
    try {
      const made = await create.mutateAsync(sent.submitted);
      if (!left.current) void navigate({ to: "/hobs/$hobId/new", params: { hobId: made.id }, replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.tag === "InvalidHob") setDraft(reopenDraft(sent));
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
            <h1 className="m-0 font-pixel text-[32px] font-bold text-moonlight">Summon a hob</h1>
            <span className="text-secondary-text">
              Describe the chores in your own words. Hobbots writes the instructions, and you can change anything before
              the hob starts.
            </span>
          </div>
          <Button type="button" variant="outline" onClick={cancel}>
            Cancel
          </Button>
        </div>

        {/* The choices are disabled once sent: the hob may already exist with exactly these. */}
        <div className="grid min-h-0 flex-1 animate-hb-in grid-cols-[minmax(0,1fr)_430px] gap-7">
          <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0 disabled:opacity-85">
            <legend className="sr-only">{locked ? `${name}'s chores, as sent` : "What the hob does"}</legend>
            <div className="flex flex-col gap-2">
              <label htmlFor="hob-chores" className="font-bold">
                What should this hob do?
              </label>
              <textarea
                id="hob-chores"
                value={draft.chores}
                maxLength={CHORES_MAX}
                onChange={(e) => {
                  const chores = e.target.value;
                  setDraft((d) => ({ ...d, chores, choresEdited: true }));
                }}
                placeholder="Tell it about the chores, like you would tell a friend who is helping out."
                className="h-[110px] resize-none border-2 border-control bg-deep px-3.5 py-3 leading-normal text-text placeholder:text-label"
              />
            </div>

            <CraftChoices
              draft={draft}
              onChange={(update) =>
                setDraft((d) => {
                  const next = update(d);
                  return next.kind === d.kind ? next : pickKind(d, next.kind);
                })
              }
              legend={<legend className="mb-2 text-sm text-secondary-text">Or start from a kind of hob</legend>}
            />

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="lbl mb-2 text-moonlight">Where {name} works</legend>
              <div className="grid grid-cols-3 gap-2.5">
                <Choice name="hob-place" checked onPick={() => {}} className="flex-col items-start gap-1 p-3">
                  <span className="font-bold">The hub</span>
                  <span className="text-[13px] leading-snug opacity-85">Uses the hub's files and apps</span>
                </Choice>
                <div className="cut flex flex-col items-start gap-1 border-2 border-dashed border-control p-3 text-sm">
                  <span className="flex items-center gap-2 font-bold">
                    A sandbox on the hub
                    <span className="bg-lantern px-1.5 text-xs text-ground">Later</span>
                  </span>
                  <span className="text-[13px] leading-snug text-secondary-text">Isolated, safer for code</span>
                </div>
              </div>
            </fieldset>

            <section
              aria-label={`${name} asks you first`}
              className="cut flex flex-col gap-2.5 border-2 border-line bg-card px-4 py-3.5"
            >
              <span className="lbl text-moonlight">{name} asks you first before</span>
              {setup.data &&
                presetInfo(setup.data.safetyPreset).rules.map(([rule, answer]) => (
                  <div key={rule} className="flex items-center gap-3 text-sm">
                    <span className="flex-1">{rule.toLowerCase()}</span>
                    <span className={cn("text-[13px]", ANSWER[answer].className)}>{ANSWER[answer].text}</span>
                  </div>
                ))}
              <span className="text-[13px] text-label">
                {setup.data ? `From your ${presetInfo(setup.data.safetyPreset).label} safety. ` : ""}Hobs only chat
                today, so these apply once they can act.
              </span>
            </section>
          </fieldset>

          <section aria-label="Preview" className="flex flex-col self-start border-[3px] border-text bg-card">
            <fieldset disabled={locked} className="m-0 flex flex-col border-0 p-0 disabled:opacity-85">
              <legend className="sr-only">{locked ? `${name}, as sent` : "Who the hob is"}</legend>
              <div className="relative h-[170px] flex-none overflow-hidden border-b-[3px] border-line-2 bg-panel">
                <Stars count={10} height={100} />
                <div aria-hidden className="absolute inset-x-0 bottom-0 h-9 bg-line" />
                {lookRolls > 0 && (
                  // A puff as the hob changes its look; it fades by itself and never shows under Reduce motion.
                  <span
                    key={lookRolls}
                    aria-hidden
                    className="pointer-events-none absolute bottom-5 left-1/2 -ml-[60px] h-[100px] w-[120px] animate-hb-poof rounded-full bg-text motion-reduce:hidden"
                  />
                )}
                <button
                  type="button"
                  onClick={newLook}
                  aria-label={`New look for ${name}`}
                  title="Click for a new look"
                  className="absolute bottom-[22px] left-1/2 -ml-[50px] cursor-pointer border-0 bg-transparent p-0 hover:brightness-110"
                >
                  <span key={[draft.kind, draft.lookColor, draft.model, draft.effort, nameRolls].join(" ")}>
                    <span className="block animate-hb-hop">
                      <HobSprite hob={draft} size={100} state="thinking" />
                    </span>
                  </span>
                </button>
                <div className="absolute top-3 left-3 flex flex-col items-start gap-1">
                  <Button type="button" variant="outline" size="xs" onClick={newLook} className="bg-ground">
                    New look
                  </Button>
                  <span aria-live="polite" title={look.recipe} className="text-[11px] text-label">
                    Look #{draft.lookSeed}
                    <span className="sr-only">, {look.recipe}</span>
                  </span>
                </div>
                <fieldset className="absolute top-3 right-3 m-0 border-0 p-0">
                  <legend className="sr-only">Colors</legend>
                  <ColorSwatches
                    value={draft.lookColor}
                    onPick={(lookColor) => setDraft((d) => ({ ...d, lookColor }))}
                    size="small"
                    className="grid grid-cols-2 gap-1.5"
                  />
                </fieldset>
              </div>

              <div className="flex flex-col gap-2.5 px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <label htmlFor="hob-name" className="sr-only">
                    Hob name
                  </label>
                  <input
                    id="hob-name"
                    value={draft.name}
                    maxLength={LABEL_MAX}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDraft((d) => ({ ...d, name: value, named: true }));
                    }}
                    className="w-[130px] border-0 border-b-2 border-dashed border-control bg-transparent px-0 py-0.5 font-pixel text-[26px] font-bold text-text"
                  />
                  <NameDice
                    size={18}
                    rolls={nameRolls}
                    onRoll={() => {
                      setDraft((d) => ({ ...d, name: rollName(d.name), named: true }));
                      setNameRolls((n) => n + 1);
                    }}
                    className="size-9"
                  />
                  <span className="min-w-0 truncate text-secondary-text">{kindLine(draft)}</span>
                </div>

                <div className="flex flex-col gap-1.5 border-t-2 border-line pt-[9px]">
                  <span className="text-sm text-label">Thinks with</span>
                  <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
                    <legend className="sr-only">Provider</legend>
                    {connected && (
                      <Choice name="hob-provider" checked onPick={() => {}} className="px-[9px] py-1 text-[13px]">
                        <span
                          aria-hidden
                          className="grid size-4 place-items-center bg-[#e39a74] text-[11px] font-bold text-ground"
                        >
                          C
                        </span>
                        Claude
                      </Choice>
                    )}
                  </fieldset>
                  {runtimes.data && !connected ? (
                    <span role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-lantern">
                      {notice} <Link to="/settings">Open Settings</Link>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => void runtimes.refetch()}
                        disabled={runtimes.isFetching}
                      >
                        {runtimes.isFetching ? "Checking…" : "Check again"}
                      </Button>
                    </span>
                  ) : models.isPending ? (
                    <span className="py-1 text-sm text-lantern">
                      Asking Claude Code for its models <span className="animate-hb-blink">•••</span>
                    </span>
                  ) : models.isError ? (
                    <span role="alert" className="flex items-center gap-3 text-sm text-rose">
                      Hobbots could not get Claude Code's models.
                      <Button type="button" variant="outline" size="xs" onClick={() => void models.refetch()}>
                        Try again
                      </Button>
                    </span>
                  ) : (
                    <Brain models={models.data.models} draft={draft} onChange={setDraft} compact />
                  )}
                </div>

                <div className="flex gap-3 border-t-2 border-line pt-[9px] text-sm">
                  <span className="w-[92px] flex-none text-label">Runs</span>
                  <span className="flex-1 leading-snug">When you or another hob asks · schedules come later</span>
                </div>
              </div>
            </fieldset>

            <div className="mt-auto flex flex-col gap-2 px-4 pb-4">
              <Button
                type="submit"
                aria-disabled={problem !== undefined || create.isPending}
                aria-describedby="summon-hint"
                className={cn(
                  "w-full",
                  problem && "cursor-not-allowed bg-line-2 text-label shadow-[0_4px_0_#22203f] hover:bg-line-2",
                )}
              >
                Summon {name}
              </Button>
              <span
                id="summon-hint"
                role={create.isError ? "alert" : undefined}
                className={cn(
                  "min-h-5 text-center text-sm",
                  create.isError ? "text-rose" : problem && tried ? "text-lantern" : "text-secondary-text",
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
