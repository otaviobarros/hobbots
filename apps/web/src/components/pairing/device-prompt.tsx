import type { WaitingDevice } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type PairingDecision, usePromptedDevices } from "../../api/pairing.ts";
import { useNow } from "../inbox/use-now.ts";
import { DeviceFacts, MatchingCode, PairingActions } from "./device-request.tsx";
import { messages } from "./messages.ts";

const copy = messages.prompt;

interface Answered {
  readonly device: WaitingDevice;
  readonly decision: Exclude<PairingDecision, "later">;
}

/**
 * The prompt on the hub (screen 4): over the hub's own window, the oldest device still waiting for
 * an answer, with Allow, Deny and Decide later. It shows only in the desktop app's window; every
 * other approved device finds the request in Needs you.
 */
export function DevicePrompt() {
  const waiting = usePromptedDevices();
  const [answered, setAnswered] = useState<Answered | undefined>(undefined);
  const device = waiting[0];
  if (globalThis.window?.hobbots === undefined) return null;
  if (answered !== undefined) return <AnsweredPrompt answered={answered} onDone={() => setAnswered(undefined)} />;
  if (device === undefined) return null;
  return (
    <PromptFrame titleId="device-prompt-title" tone="ask">
      <AskingPrompt
        key={device.request.id}
        device={device}
        onDecided={(decision) => decision !== "later" && setAnswered({ device, decision })}
      />
    </PromptFrame>
  );
}

function PromptFrame({
  titleId,
  tone,
  children,
}: {
  titleId: string;
  tone: "ask" | "allowed" | "denied";
  children: ReactNode;
}) {
  const border = tone === "allowed" ? "border-mint-deep" : tone === "denied" ? "border-rose" : "border-control";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/70 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`cut flex w-full max-w-[560px] animate-hb-pop flex-col gap-3.5 border-2 bg-panel px-7 py-6 ${border}`}
      >
        {children}
      </div>
    </div>
  );
}

function AskingPrompt({
  device,
  onDecided,
}: {
  device: WaitingDevice;
  onDecided: (decision: PairingDecision) => void;
}) {
  const now = useNow();
  const heading = useRef<HTMLHeadingElement>(null);
  // The prompt takes focus when it opens, so a keyboard user lands in it.
  useEffect(() => heading.current?.focus(), []);
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className="lbl flex items-center gap-1.5 text-xs text-lantern">
          <span aria-hidden className="inline-block size-2 animate-hb-blink bg-lantern" />
          {copy.kicker}
        </span>
        <h2
          id="device-prompt-title"
          ref={heading}
          tabIndex={-1}
          className="m-0 font-pixel text-2xl font-bold break-words text-moonlight outline-none"
        >
          {copy.title({ name: device.request.name })}
        </h2>
      </div>
      <DeviceFacts device={device} now={now} />
      <MatchingCode device={device} />
      <p className="m-0 text-[13px] leading-normal text-secondary-text">{copy.grants}</p>
      <PairingActions device={device} canDefer onDecided={onDecided} />
    </>
  );
}

function AnsweredPrompt({ answered, onDone }: { answered: Answered; onDone: () => void }) {
  const allowed = answered.decision === "allow";
  const name = answered.device.request.name;
  return (
    <PromptFrame titleId="device-answered-title" tone={allowed ? "allowed" : "denied"}>
      <div role="status" className="flex flex-col items-center gap-2.5 py-2 text-center">
        <h2 id="device-answered-title" className="m-0 font-pixel text-2xl font-bold break-words text-moonlight">
          {allowed ? copy.allowedTitle({ name }) : copy.deniedTitle({ name })}
        </h2>
        <p className="m-0 text-secondary-text">{allowed ? copy.allowedIntro : copy.deniedIntro}</p>
        <Button variant="outline" className="mt-1.5" autoFocus onClick={onDone}>
          {copy.done}
        </Button>
      </div>
    </PromptFrame>
  );
}
