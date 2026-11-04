import { Button } from "@hobbots/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import {
  describeBrowser,
  hubNameQuery,
  pairingStatusQuery,
  useAskToPair,
  useStartOver,
  type WaitingState,
} from "../../api/pairing.ts";
import { formatTime } from "../../lib/time.ts";
import { Stars } from "../scene.tsx";
import { groupedCode } from "./device-request-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/** Where the app opens once the hub let this browser in: a fresh load, so every read starts with its device. */
const openHobbots = () => globalThis.location.replace(`${globalThis.location.pathname}#/`);

/**
 * The pairing screen of a browser without a device (screen 4, ADR 021): it asks once under a name the
 * user can change, then waits with the matching code until the hub answers. Allowed, it opens Hobbots;
 * denied or expired, it can ask again.
 */
export function PairingScreen() {
  const status = useQuery(pairingStatusQuery);
  const hub = useQuery(hubNameQuery).data ?? copy.thisHub;
  const allowed = status.data?._tag === "Allowed";
  useEffect(() => {
    if (allowed) openHobbots();
  }, [allowed]);

  return (
    <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-ground px-4 py-10">
      <Stars count={30} height={260} />
      <div className="cut relative z-10 flex w-full max-w-[480px] flex-col gap-4 border-2 border-control bg-panel px-7 py-6">
        {status.isPending && <p className="m-0 text-label">{copy.ask.asking}</p>}
        {status.isError && <AskForm hub={hub} failed />}
        {status.data !== undefined && <Screen state={status.data} hub={hub} />}
      </div>
    </main>
  );
}

function Screen({ state, hub }: { state: WaitingState; hub: string }) {
  switch (state._tag) {
    case "Ask":
      return <AskForm hub={hub} />;
    case "Waiting":
      return <Waiting code={state.status.code} expiresAt={state.status.expiresAt} hub={hub} />;
    case "Allowed":
      return (
        <p role="status" className="m-0 text-mint">
          {copy.allowed}
        </p>
      );
    case "Denied":
      return <Ended title={copy.denied.title({ hub })} intro={copy.denied.intro} />;
    case "Expired":
      return <Ended title={copy.expired.title} intro={copy.expired.intro} />;
    case "Throttled":
      return <Ended title={copy.throttled.title} intro={copy.throttled.intro({ count: state.seconds })} />;
    case "NotYours":
      return <Ended title={copy.notYours.title} intro={copy.notYours.intro} />;
  }
}

function AskForm({ hub, failed = false }: { hub: string; failed?: boolean }) {
  const nameId = useId();
  const hintId = useId();
  const [described] = useState(() => describeBrowser(globalThis.navigator?.userAgent ?? ""));
  const [name, setName] = useState(() => copy.suggestedName(described));
  const ask = useAskToPair();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() !== "") ask.mutate({ name: name.trim(), platform: described.platform ?? "" });
  };
  return (
    <form className="flex flex-col gap-3.5" onSubmit={submit}>
      <h1 className="m-0 font-pixel text-2xl font-bold text-moonlight">{copy.ask.title({ hub })}</h1>
      <p className="m-0 text-text-secondary">{copy.ask.intro}</p>
      <label htmlFor={nameId} className="font-bold">
        {copy.ask.nameLabel}
      </label>
      <input
        id={nameId}
        aria-describedby={hintId}
        value={name}
        maxLength={64}
        onChange={(event) => setName(event.target.value)}
        className="cut border-2 border-control bg-ground px-3 py-2 text-text-strong"
      />
      <span id={hintId} className="-mt-2 text-[13px] text-label">
        {copy.ask.nameHint}
      </span>
      <Button type="submit" className="self-start" disabled={ask.isPending || name.trim() === ""}>
        {ask.isPending ? copy.ask.asking : copy.ask.submit}
      </Button>
      {(failed || ask.isError) && (
        <p role="alert" className="m-0 text-sm text-rose">
          {copy.ask.failed}
        </p>
      )}
    </form>
  );
}

function Waiting({ code, expiresAt, hub }: { code: string; expiresAt: string; hub: string }) {
  return (
    <div role="status" className="flex flex-col gap-3.5">
      <span className="lbl flex items-center gap-1.5 text-xs text-lantern">
        <span aria-hidden className="inline-block size-2 animate-hb-blink bg-lantern" />
        {copy.waiting.codeLabel}
      </span>
      <h1 className="m-0 font-pixel text-2xl font-bold text-moonlight">{copy.waiting.title({ hub })}</h1>
      <span className="cut self-start bg-text-strong px-5 py-3 font-pixel text-4xl font-bold tracking-[0.12em] text-ground">
        {groupedCode(code)}
      </span>
      <p className="m-0 text-text-secondary">{copy.waiting.intro({ hub })}</p>
      <p className="m-0 text-[13px] text-label">{copy.waiting.expires({ time: formatTime(expiresAt) })}</p>
    </div>
  );
}

function Ended({ title, intro }: { title: string; intro: string }) {
  const startOver = useStartOver();
  return (
    <div className="flex flex-col gap-3.5">
      <h1 className="m-0 font-pixel text-2xl font-bold text-moonlight">{title}</h1>
      <p role="status" className="m-0 text-text-secondary">
        {intro}
      </p>
      <Button variant="outline" className="self-start" onClick={startOver}>
        {copy.askAgain}
      </Button>
    </div>
  );
}
