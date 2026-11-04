import type { TailscaleState } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { messages } from "../messages.ts";

const copy = messages.remoteSetup;

/** Where Tailscale is downloaded, for every platform. */
export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

/** Tailscale is not ready on this computer: how to get it ready, and Check again, which Hobbots also does by itself. */
export function TailscaleNotReady({
  state,
  checking,
  onCheck,
}: {
  state: Exclude<TailscaleState, "running">;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <section
      aria-label={copy.missing[state]}
      className="cut flex max-w-[720px] flex-col gap-2.5 border-2 border-lantern bg-card px-[18px] py-4"
    >
      <span className="font-bold">{copy.missing[state]}</span>
      <span className="text-ui leading-normal text-text-secondary">{copy.missingBody}</span>
      <ol className="m-0 flex list-none flex-col gap-1 p-0 text-ui leading-normal">
        {copy.steps.map((step, index) => (
          <li key={step}>
            <b className="text-lantern">{copy.stepNumber({ n: index + 1 })}</b> {step}
          </li>
        ))}
      </ol>
      <span className="flex flex-wrap gap-2.5 pt-1">
        <Button asChild variant="outline" size="sm">
          <a href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
            {messages.remoteAccess.getTailscale}
          </a>
        </Button>
        <Button variant="outline" size="sm" disabled={checking} onClick={onCheck}>
          {checking ? copy.checking : copy.checkAgain}
        </Button>
      </span>
    </section>
  );
}
