import type { Agent } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.ts";
import { type FirstHobDraft, hobLine, keepDraft, reopenDraft, submitDraft } from "../api/first-hob.ts";
import { modelsQuery, useCreateHob } from "../api/queries.ts";
import { foldersShared, presetInfo } from "../api/safety.ts";
import { setupQuery, useUpdateSetup } from "../api/setup.ts";
import { HobSprite } from "./hob-sprite.tsx";
import { OnboardingFrame } from "./onboarding-frame.tsx";
import { useFirstHobDraft } from "./onboarding-safety.tsx";

const READY_GUIDE = "Everything is ready. Light the circle and your first hob will appear.";
const DONE_GUIDE = "There it is! Say hello. I will be in the corner of Home if you need me.";

const RUNES = 8;
const RING = 300;
const RUNE = 14;

/** The runes around the circle, from the top, clockwise. */
const runes = Array.from({ length: RUNES }, (_, i) => {
  const angle = (i / RUNES) * Math.PI * 2 - Math.PI / 2;
  const radius = RING / 2 - RUNE / 2 - 1;
  return {
    left: Math.round(RING / 2 - RUNE / 2 + Math.cos(angle) * radius),
    top: Math.round(RING / 2 - RUNE / 2 + Math.sin(angle) * radius),
  };
});

const SPARKS = [
  { dx: "-34px", dy: "-26px", color: "bg-moonlight" },
  { dx: "34px", dy: "-26px", color: "bg-moonlight" },
  { dx: "-42px", dy: "6px", color: "bg-moonlight" },
  { dx: "42px", dy: "6px", color: "bg-moonlight" },
  { dx: "-18px", dy: "30px", color: "bg-lantern" },
  { dx: "18px", dy: "30px", color: "bg-mint" },
];

/** idle → charging (runes light one by one while the hub creates the hob) → poof → done. */
type Ritual = "idle" | "charging" | "poof" | "done";

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Onboarding step 5: the summon. It creates the first hob from the draft, marks setup complete
 * and, once the circle is lit, shows the hob with its chat and Home one click away.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: predates the complexity limit (STD-ARCH-012). Split it before adding more branches.
export function OnboardingReady() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const setup = useQuery(setupQuery);
  const models = useQuery(modelsQuery("claude-code"));
  const create = useCreateHob();
  const update = useUpdateSetup();
  const [draft, setDraft] = useState<FirstHobDraft>(useFirstHobDraft());
  const [ritual, setRitual] = useState<Ritual>("idle");
  const [lit, setLit] = useState(0);
  const [hob, setHob] = useState<Agent | null>(null);

  // The runes light one by one while the hub works; under Reduce motion they light at once.
  useEffect(() => {
    if (ritual !== "charging" || lit >= RUNES) return;
    const timer = setTimeout(() => setLit((n) => n + 1), 150);
    return () => clearTimeout(timer);
  }, [ritual, lit]);
  // The hob appears once the circle is lit and the hub has made it and finished setup.
  useEffect(() => {
    if (ritual === "charging" && lit >= RUNES && hob) setRitual(reducedMotion() ? "done" : "poof");
  }, [ritual, lit, hob]);
  useEffect(() => {
    if (ritual !== "poof") return;
    const timer = setTimeout(() => setRitual("done"), 350);
    return () => clearTimeout(timer);
  }, [ritual]);

  const summon = async () => {
    if (ritual !== "idle") return;
    setRitual("charging");
    setLit(reducedMotion() ? RUNES : 0);
    // Once sent, the hob may exist even when no answer comes back, so the draft locks and every
    // retry repeats the same request; the hub returns the hob it made the first time.
    const sent = submitDraft(draft);
    setDraft(sent);
    keepDraft(sent);
    try {
      const made = await create.mutateAsync(sent.submitted);
      await update.mutateAsync({ completed: true });
      keepDraft(null);
      setHob(made);
    } catch (error) {
      if (error instanceof ApiError && error.tag === "InvalidHob") {
        const reopened = reopenDraft(sent);
        setDraft(reopened);
        keepDraft(reopened);
      }
      setRitual("idle");
      setLit(0);
    }
  };

  const back = () => (canGoBack ? router.history.back() : void navigate({ to: "/setup/folders" }));
  const name = draft.name.trim() || "your hob";
  const model = models.data?.models.find((m) => m.id === draft.model);
  const done = ritual === "done";
  const rejected = create.error instanceof ApiError && create.error.tag === "InvalidHob" ? create.error : undefined;
  const failed = ritual === "idle" && (create.isError || update.isError);
  const problem = rejected
    ? `Hobbots could not create ${name}: ${rejected.message}. Go back to change it.`
    : failed
      ? `Hobbots could not finish summoning ${name}. Try again in a moment.`
      : undefined;

  return (
    <OnboardingFrame
      step={4}
      guide={done ? DONE_GUIDE : READY_GUIDE}
      sofar={[
        "Claude connected",
        `${hobLine(draft)} on Claude`,
        ...(setup.data
          ? [`${presetInfo(setup.data.safetyPreset).label} safety`, foldersShared(setup.data.approvedFolders.length)]
          : []),
      ]}
      footer={
        done ? null : (
          <>
            <Button variant="outline" onClick={back} disabled={ritual !== "idle"}>
              Back
            </Button>
            <span role={problem ? "alert" : undefined} className="flex-1 text-right text-sm text-rose">
              {problem}
            </span>
          </>
        )
      }
    >
      <div className="flex animate-hb-in flex-col items-center gap-2.5 pt-1 text-center">
        <h1 aria-live="polite" className="m-0 font-pixel text-[30px] font-bold text-moonlight">
          {done ? `${name} has arrived!` : "Ready to summon"}
        </h1>
        <p className="m-0 text-secondary-text">
          {done
            ? `${name} is waiting in Hobs, ready for a first chore.`
            : `${hobLine(draft)} · thinks with Claude ${model?.displayName ?? ""}`.trim()}
        </p>

        <div aria-hidden className="relative my-1.5" style={{ width: RING, height: RING }}>
          <div
            className={cn(
              "absolute inset-0 rounded-full border-4 border-dashed",
              ritual === "idle" ? "border-line-2" : "border-moonlight",
              ritual === "charging" && "animate-hb-spin",
            )}
          />
          <div className="absolute inset-[34px] rounded-full border-4 border-line" />
          {runes.map((rune, i) => {
            const on = done || i < lit;
            return (
              <span
                key={`${rune.left}-${rune.top}`}
                className={cn("absolute", on ? "bg-moonlight shadow-[0_0_12px_3px_rgba(243,233,181,.6)]" : "bg-line-2")}
                style={{ left: rune.left, top: rune.top, width: RUNE, height: RUNE }}
              />
            );
          })}
          {ritual === "poof" && (
            <span className="absolute top-[90px] left-[90px] size-[120px] animate-hb-poof rounded-full bg-text" />
          )}
          {done && hob && (
            <>
              <div className="absolute top-[80px] left-[87px] animate-hb-pop">
                <HobSprite hob={hob} size={126} state="thinking" />
              </div>
              <span className="absolute top-[140px] left-[150px]">
                {SPARKS.map((spark) => (
                  <span
                    key={`${spark.dx}${spark.dy}`}
                    className={cn("absolute size-1.5 animate-hb-spark", spark.color)}
                    style={{ "--dx": spark.dx, "--dy": spark.dy } as React.CSSProperties}
                  />
                ))}
              </span>
            </>
          )}
        </div>

        {ritual === "idle" && (
          <Button onClick={() => void summon()} disabled={!setup.data}>
            {failed ? "Try again" : `Summon ${name}`}
          </Button>
        )}
        {(ritual === "charging" || ritual === "poof") && (
          <span role="status" className="py-[11px] font-bold text-lantern">
            Gathering moonlight <span className="animate-hb-blink">•••</span>
          </span>
        )}
        {done && hob && (
          <div className="flex animate-hb-in gap-3">
            <Button asChild>
              <Link to="/hobs/$hobId/new" params={{ hobId: hob.id }}>
                Say hi to {hob.name}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/">Go to Home</Link>
            </Button>
          </div>
        )}
      </div>
    </OnboardingFrame>
  );
}
