import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { canContinueSetup, runtimeProblem } from "../api/runtime-health.ts";
import { useUpdateSetup } from "../api/setup.ts";
import { ChiefMark } from "./chief-mark.tsx";
import {
  availabilityLabel,
  LATER_PROVIDERS,
  ProviderRow,
  ProviderTile,
  RuntimeFix,
  useClaudeRuntime,
} from "./runtime.tsx";
import { Stars } from "./scene.tsx";

/**
 * Onboarding step 1: the providers found on this computer. Claude Code's real health decides
 * whether setup can continue; each problem shows its fix and Check again, so fixing it in a
 * terminal is enough, without restarting Hobbots.
 */
export function OnboardingProviders() {
  const navigate = useNavigate();
  const update = useUpdateSetup();
  const { pending, checking, failed, runtimes, claude, checkAgain } = useClaudeRuntime();
  const problem = runtimeProblem(claude);
  const ready = canContinueSetup(runtimes);

  // The first-hob step (#68) takes over from here; until it exists, setup ends on Home.
  const continueSetup = () => update.mutate({ completed: true }, { onSuccess: () => navigate({ to: "/" }) });

  return (
    <main className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto bg-panel px-9 py-10">
      <Stars count={24} height={260} />
      <div className="relative flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-center gap-4">
          <ChiefMark size={64} />
          <div className="flex flex-col gap-1">
            <span className="text-sm text-label">Step 1 of 5</span>
            <h1 className="m-0 font-pixel text-[28px] font-bold text-moonlight">Who will your hobs think with?</h1>
          </div>
        </div>
        <p className="m-0 text-[17px] leading-normal">
          Hobs think with an AI provider you already use on this computer. Let me look for one.
        </p>

        <section aria-labelledby="claude-provider" aria-live="polite" className="cut bg-card p-4">
          <div className="flex items-center gap-2">
            <ProviderTile />
            <h2 id="claude-provider" className="m-0 flex-1 font-pixel text-base font-semibold">
              Claude Code
            </h2>
            <Badge variant={claude?.availability === "ready" ? "working" : "waiting"}>
              {pending ? "Checking" : failed ? "Unknown" : availabilityLabel[claude?.availability ?? "unavailable"]}
            </Badge>
          </div>
          {pending && <p className="mt-2 mb-0 text-sm text-label">Looking on this Mac…</p>}
          {claude?.availability === "ready" && (
            <p className="mt-2 mb-0 text-sm">
              Found and signed in{claude.version ? `, version ${claude.version}` : ""}.
            </p>
          )}
          {problem !== null && <RuntimeFix problem={problem} checking={checking} onCheckAgain={checkAgain} />}
          {(failed || claude?.availability === "unverified") && (
            <>
              <p className="mt-2 mb-0 text-sm text-lantern">
                {failed
                  ? "Hobbots could not reach its server to check Claude Code."
                  : "Hobbots could not tell whether Claude Code is ready."}
              </p>
              <div className="mt-2">
                <Button variant="outline" size="sm" onClick={checkAgain} disabled={checking}>
                  {checking ? "Looking on this Mac…" : "Check again"}
                </Button>
              </div>
            </>
          )}
        </section>

        <section aria-labelledby="later-providers">
          <h2 id="later-providers" className="m-0 mb-1 text-sm font-normal text-label">
            Coming later
          </h2>
          {LATER_PROVIDERS.map((p) => (
            <ProviderRow key={p.name} name={p.name} mark={p.mark} color={p.color}>
              <Badge variant="later">Later</Badge>
            </ProviderRow>
          ))}
        </section>

        <div className="flex flex-col items-end gap-2">
          <Button
            onClick={continueSetup}
            disabled={!ready || update.isPending}
            aria-describedby={ready ? undefined : "providers-continue-note"}
          >
            Continue
          </Button>
          {!ready && (
            <span id="providers-continue-note" className="text-sm text-label">
              Continue needs one ready provider.
            </span>
          )}
          {update.isError && (
            <span role="alert" className="text-sm text-rose">
              Hobbots could not save that. Try again in a moment.
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
