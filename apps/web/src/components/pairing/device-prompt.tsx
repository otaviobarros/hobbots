import type { WaitingDevice } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@hobbots/ui/components/dialog";
import { type ReactNode, useRef, useState } from "react";
import { type PairingDecision, usePromptedDevices } from "../../api/pairing.ts";
import { formatWhen } from "../../lib/time.ts";
import { ChiefMark } from "../chief/chief-mark.tsx";
import { useNow } from "../inbox/use-now.ts";
import { PairingActions } from "./device-request.tsx";
import { askedFrom, groupedCode, usingText } from "./device-request-model.ts";
import { messages } from "./messages.ts";

const copy = messages.prompt;

interface Answered {
  readonly device: WaitingDevice;
  readonly decision: Exclude<PairingDecision, "later">;
}

/**
 * The prompt on the hub (screen 4): over the hub's own window, the oldest device still waiting for
 * an answer, held at the gate by the Chief, with its matching code and Decide later, Not mine and Allow. It shows only in the desktop app's window; every
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
  const asked = [usingText(device), askedFrom(device), formatWhen(device.request.createdAt, now)].join(" · ");
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="grid size-10 flex-none place-items-center rounded-control bg-deep">
          <ChiefMark size={34} />
        </span>
        <span className="flex min-w-0 flex-col">
          <DialogTitle tabIndex={-1} className="lbl m-0 text-label outline-none">
            {copy.joinTitle}
          </DialogTitle>
          <span className="text-detail text-text-secondary">{copy.atTheGate}</span>
        </span>
      </div>
      {/* The name is the device's own words, so it is plain text, cut to one line. */}
      <div className="flex items-center gap-3 rounded-card bg-card p-3">
        <span aria-hidden className="h-9 w-6 flex-none rounded-[3px] border-3 border-text-strong bg-deep" />
        <span className="flex min-w-0 flex-col">
          <strong className="truncate text-[17px]" title={device.request.name}>
            {device.request.name}
          </strong>
          <span className="text-detail text-text-secondary">{asked}</span>
        </span>
      </div>
      <div className="flex flex-col items-center gap-1 rounded-card bg-card p-3 text-center">
        <span className="lbl text-label">{copy.matchLabel}</span>
        <span className="font-mono text-[30px] tracking-[0.12em] text-moonlight">
          {groupedCode(device.request.code)}
        </span>
        <span className="text-detail text-text-secondary">{copy.matchOnly}</span>
      </div>
      <p className="m-0 text-detail leading-[18px] text-text-secondary">{copy.grants}</p>
      <PairingActions device={device} canDefer onDecided={onDecided} atGate />
    </>
  );
}

function AnsweredPrompt({ answered, onDone }: { answered: Answered; onDone: () => void }) {
  const allowed = answered.decision === "allow";
  const name = answered.device.request.name;
  return (
    <div role="status" className="flex flex-col items-center gap-2.5 py-2 text-center">
      <DialogTitle className="m-0 font-heading text-2xl font-bold break-words text-moonlight">
        {allowed ? copy.allowedTitle({ name }) : copy.deniedTitle({ name })}
      </DialogTitle>
      <p className="m-0 text-text-secondary">{allowed ? copy.allowedIntro : copy.deniedIntro}</p>
      <Button variant="outline" className="mt-1.5" autoFocus onClick={onDone}>
        {copy.done}
      </Button>
    </div>
  );
}
