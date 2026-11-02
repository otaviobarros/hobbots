import { Button } from "@hobbots/ui/components/button";
import { hubNameOf } from "../lib/hub-name.ts";
import { ChiefMark } from "./chief-mark.tsx";
import { messages } from "./messages.ts";

const copy = messages.deviceAccess;

/**
 * What a revoked device sees (ADR 021): it was removed from the hub, and Ask again starts pairing.
 * The hub already dropped this browser's cookie, so the page loaded again asks to pair.
 */
export function DeviceRemoved() {
  const hub = hubNameOf(globalThis.location?.hostname ?? "");
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center bg-ground px-6">
      <section
        aria-labelledby="device-removed-title"
        className="cut flex w-full max-w-[560px] animate-hb-in flex-col items-center gap-3 border-2 border-control bg-panel px-[30px] py-[26px] text-center"
      >
        <ChiefMark mood="idle" size={56} />
        <h1 id="device-removed-title" className="m-0 font-pixel text-2xl font-bold text-moonlight">
          {hub === null ? copy.removedTitleNoName : copy.removedTitle({ hub })}
        </h1>
        <p className="m-0 leading-normal text-secondary-text">{copy.removedBody}</p>
        <Button className="mt-1.5" onClick={() => globalThis.location.reload()}>
          {copy.askAgain}
        </Button>
      </section>
    </main>
  );
}
