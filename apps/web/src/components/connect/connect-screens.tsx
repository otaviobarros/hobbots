import type { AddressRefusal, ConnectEnd, WaitingView } from "@hobbots/api";
import { Button } from "@hobbots/ui/components/button";
import { type FormEvent, type ReactNode, useId } from "react";
import { formatTime } from "../../lib/time.ts";
import { OnboardingFrame } from "../onboarding/onboarding-frame.tsx";
import { groupedCode } from "../pairing/device-request-model.ts";
import { endedText, refusalText, type SetupBridge } from "./connect-model.ts";
import { FoundHubs } from "./found-hubs.tsx";
import { messages } from "./messages.ts";

const copy = messages;

/** A setup step in the setup frame, with the Chief in the preview and its buttons along the bottom. */
function SetupStep({
  stage,
  speech,
  children,
  footer,
}: {
  stage: string;
  speech: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <OnboardingFrame step={null} preview={{ house: true, caption: stage, speech }} footer={footer}>
      <div className="flex flex-col gap-2">{children}</div>
    </OnboardingFrame>
  );
}

/**
 * Connect (screen 2, ADR 025): type the hub's address, or pick a hub found on the user's own
 * computers. Nothing is sent until the main process has checked the address against Tailscale.
 */
export function ConnectForm({
  bridge,
  address,
  refusal,
  busy,
  onAddress,
  onConnect,
  onBack,
}: {
  bridge: SetupBridge;
  address: string;
  refusal: AddressRefusal | undefined;
  busy: boolean;
  onAddress: (address: string) => void;
  onConnect: (address: string) => void;
  onBack: () => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const typed = address.trim() !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed && !busy) onConnect(address.trim());
  };
  return (
    <form className="flex min-h-0 flex-1" onSubmit={submit}>
      <SetupStep
        stage={copy.stage}
        speech={copy.elder.connect}
        footer={
          <>
            <Button type="button" variant="outline" onClick={onBack}>
              {copy.back}
            </Button>
            <span className="flex-1 text-end text-ui text-text-secondary">{typed ? "" : copy.hint}</span>
            <Button type="submit" disabled={!typed || busy}>
              {busy ? copy.connecting : copy.connect}
            </Button>
          </>
        }
      >
        <h1 className="m-0 font-heading text-display font-bold text-moonlight">{copy.form.title}</h1>
        <p className="m-0 mb-3.5 max-w-[700px] text-text-secondary">{copy.form.intro}</p>
        <label htmlFor={inputId} className="lbl text-label">
          {copy.form.addressLabel}
        </label>
        <input
          id={inputId}
          value={address}
          placeholder={copy.form.placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={refusal !== undefined}
          aria-describedby={refusal === undefined ? undefined : errorId}
          onChange={(event) => onAddress(event.target.value)}
          className="max-w-[700px] border-2 border-control bg-ground px-3 py-[11px] font-mono text-[17px] text-text-strong"
        />
        {refusal !== undefined && (
          <p id={errorId} role="alert" className="m-0 max-w-[700px] text-ui text-rose">
            {refusalText(refusal)}
          </p>
        )}
        <FoundHubs bridge={bridge} busy={busy} onConnect={onConnect} />
      </SetupStep>
    </form>
  );
}

/** Waiting for the hub's answer, with the computer as Tailscale names it and the matching code. */
export function ConnectWaiting({ waiting, onCancel }: { waiting: WaitingView; onCancel: () => void }) {
  const { computer } = waiting;
  return (
    <SetupStep
      stage={copy.stage}
      speech={copy.elder.waiting({ computer })}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="outline" onClick={onCancel}>
            {copy.cancel}
          </Button>
        </>
      }
    >
      <div role="status" className="flex flex-col items-center gap-2.5 pt-6 text-center">
        <h1 className="m-0 font-heading text-display font-bold text-moonlight">{copy.waiting.title({ computer })}</h1>
        <p className="m-0 max-w-column-max text-text-secondary">{copy.waiting.intro({ computer })}</p>
        <p className="m-0 text-detail text-label">
          {copy.waiting.who({ computer, owner: waiting.owner })}
          {waiting.hubName !== computer && ` · ${copy.form.calledItself({ name: waiting.hubName })}`}
        </p>
        <div className="cut my-3 flex flex-col items-center gap-1 bg-text-strong px-[34px] py-[18px] text-ground">
          <span className="lbl text-meta text-ground/70">{copy.waiting.codeLabel}</span>
          <span className="font-heading text-[44px] font-bold tracking-[0.12em]">{groupedCode(waiting.code)}</span>
        </div>
        <span className="font-bold text-lantern">
          {copy.waiting.knocking}{" "}
          <span aria-hidden>
            <span className="animate-hb-blink">•</span>
            <span className="animate-hb-blink [animation-delay:.2s]">•</span>
            <span className="animate-hb-blink [animation-delay:.4s]">•</span>
          </span>
        </span>
        <p className="m-0 text-detail text-label">{copy.waiting.expires({ time: formatTime(waiting.expiresAt) })}</p>
        <p className="m-0 max-w-column-max pt-2 text-detail text-text-secondary">
          {copy.waiting.warning({ computer })}
        </p>
      </div>
    </SetupStep>
  );
}

/** A request that did not connect: why, with Ask again and Back to the address. */
export function ConnectEnded({
  end,
  speech,
  onAskAgain,
  onBack,
}: {
  end: Extract<ConnectEnd, { kind: "ended" }>;
  speech: string;
  onAskAgain: () => void;
  onBack: () => void;
}) {
  const { title, body } = endedText(end);
  return (
    <SetupStep stage={copy.stage} speech={speech}>
      <div className="flex flex-col items-center gap-2.5 pt-10 text-center">
        <div
          aria-hidden
          className="flex size-24 animate-hb-shake items-center justify-center border-[3px] border-rose bg-line text-[44px] font-bold text-rose"
        >
          ✕
        </div>
        <h1 className="m-0 mt-2 font-heading text-display font-bold text-moonlight">{title}</h1>
        <p role="status" className="m-0 max-w-column-max text-text-secondary">
          {body}
        </p>
        <div className="flex gap-3 pt-4">
          <Button onClick={onAskAgain}>{copy.ended.askAgain}</Button>
          <Button variant="outline" onClick={onBack}>
            {copy.back}
          </Button>
        </div>
      </div>
    </SetupStep>
  );
}

/** The hub allowed this computer: its own window opens on Home in a moment. */
export function ConnectAllowed({ computer }: { computer: string }) {
  return (
    <SetupStep stage={copy.stage} speech={copy.elder.allowed({ computer })}>
      <div role="status" className="flex flex-col items-center gap-2.5 pt-10 text-center">
        <div
          aria-hidden
          className="flex size-24 animate-hb-pop items-center justify-center bg-mint-deep text-5xl font-bold text-text-strong"
        >
          ✓
        </div>
        <h1 className="m-0 mt-2 font-heading text-display font-bold text-moonlight">{copy.allowed.title}</h1>
        <p className="m-0 max-w-column-max leading-normal text-text-secondary">{copy.allowed.body({ computer })}</p>
      </div>
    </SetupStep>
  );
}
