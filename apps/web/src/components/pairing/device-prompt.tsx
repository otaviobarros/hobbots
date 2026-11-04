import type { WaitingDevice } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@hobbots/ui/components/dialog";
import { type ReactNode, useRef, useState } from "react";
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
  const done = () => setAnswered(undefined);
  if (answered === undefined && device === undefined) return null;
  const tone = answered === undefined ? "ask" : answered.decision === "allow" ? "allowed" : "denied";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Only an answered prompt closes with Escape; one still asking waits for Allow, Deny or Decide later.
        if (!open && answered !== undefined) done();
      }}
    >
      <PromptContent tone={tone} focusOnOpen={answered === undefined}>
        {answered !== undefined ? (
          <AnsweredPrompt answered={answered} onDone={done} />
        ) : (
          device !== undefined && (
            <AskingPrompt
              key={device.request.id}
              device={device}
              onDecided={(decision) => decision !== "later" && setAnswered({ device, decision })}
            />
          )
        )}
      </PromptContent>
    </Dialog>
  );
}

function PromptContent({
  tone,
  focusOnOpen,
  children,
}: {
  tone: "ask" | "allowed" | "denied";
  focusOnOpen: boolean;
  children: ReactNode;
}) {
  const border = tone === "allowed" ? "border-mint-deep" : tone === "denied" ? "border-rose" : "border-control";
  const content = useRef<HTMLDivElement>(null);
  return (
    <DialogContent
      ref={content}
      aria-describedby={undefined}
      className={`animate-hb-pop ${border}`}
      // A click outside never dismisses a device's request.
      onInteractOutside={(event) => event.preventDefault()}
      onOpenAutoFocus={(event) => {
        // The prompt's heading takes focus, so a keyboard user lands in it without pressing a button.
        if (!focusOnOpen) return;
        event.preventDefault();
        content.current?.querySelector<HTMLElement>('[data-slot="dialog-title"]')?.focus();
      }}
    >
      {children}
    </DialogContent>
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
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className="lbl flex items-center gap-1.5 text-xs text-lantern">
          <span aria-hidden className="inline-block size-2 animate-hb-blink bg-lantern" />
          {copy.kicker}
        </span>
        <DialogTitle
          tabIndex={-1}
          className="m-0 font-pixel text-2xl font-bold break-words text-moonlight outline-none"
        >
          {copy.title({ name: device.request.name })}
        </DialogTitle>
      </div>
      <DeviceFacts device={device} now={now} />
      <MatchingCode device={device} />
      <p className="m-0 text-[13px] leading-normal text-text-secondary">{copy.grants}</p>
      <PairingActions device={device} canDefer onDecided={onDecided} />
    </>
  );
}

function AnsweredPrompt({ answered, onDone }: { answered: Answered; onDone: () => void }) {
  const allowed = answered.decision === "allow";
  const name = answered.device.request.name;
  return (
    <div role="status" className="flex flex-col items-center gap-2.5 py-2 text-center">
      <DialogTitle className="m-0 font-pixel text-2xl font-bold break-words text-moonlight">
        {allowed ? copy.allowedTitle({ name }) : copy.deniedTitle({ name })}
      </DialogTitle>
      <p className="m-0 text-text-secondary">{allowed ? copy.allowedIntro : copy.deniedIntro}</p>
      <Button variant="outline" className="mt-1.5" autoFocus onClick={onDone}>
        {copy.done}
      </Button>
    </div>
  );
}
