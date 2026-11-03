import { Button } from "@hobbots/ui/components/button";
import { useId, useState } from "react";
import type { ConnectionAction } from "../api/client.ts";
import type { ConnectionReason } from "../api/connected-desktop.ts";
import { messages } from "./messages.ts";

const copy = messages.connectionBanner;

const BUTTON = "border-ground text-ground hover:bg-lantern-hover";

/** The actions this banner can take with the bridge it has; the rest wait for screens that offer them. */
const offered = (view: ConnectionReason): ReadonlyArray<ConnectionAction> => {
  const bridge = globalThis.window?.hobbots?.connection;
  return view.actions.filter(
    (action) =>
      (action === "tryAgain" && bridge?.retry !== undefined) ||
      (action === "openTailscale" && bridge?.openTailscale !== undefined) ||
      (action === "changeAddress" && bridge?.changeAddress !== undefined),
  );
};

/** Types the hub's new address, as after its port changed while this app was away (ADR 025). */
function ChangeAddress({ address, onDone }: { address: string; onDone: () => void }) {
  const id = useId();
  const [text, setText] = useState(address);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = async () => {
    const change = globalThis.window?.hobbots?.connection?.changeAddress;
    if (change === undefined) return;
    setPending(true);
    const answer = await change(text).finally(() => setPending(false));
    if (answer.ok) onDone();
    else setRefusal(answer.message);
  };
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id}>{copy.addressLabel}</label>
      <input
        id={id}
        value={text}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={refusal !== null}
        aria-describedby={refusal === null ? undefined : `${id}-refusal`}
        onChange={(event) => {
          setRefusal(null);
          setText(event.target.value);
        }}
        className="min-w-0 flex-1 border-2 border-ground bg-deep px-2 py-0.5 font-mono text-xs font-normal text-text outline-none focus-visible:outline-3 focus-visible:outline-moonlight"
      />
      <Button type="submit" variant="outline" size="xs" className={BUTTON} disabled={pending}>
        {pending ? copy.connecting : copy.connect}
      </Button>
      <Button type="button" variant="outline" size="xs" className={BUTTON} onClick={onDone}>
        {copy.cancel}
      </Button>
      {refusal !== null && (
        <span id={`${id}-refusal`} role="alert" className="w-full font-normal">
          {refusal}
        </span>
      )}
    </form>
  );
}

/**
 * The reconnecting banner on a connected desktop (ADR 025): why the hub cannot be reached, in the
 * app's words, and what the user can do. The page stays, so the open thread and its unsent message
 * stay too.
 */
export function ConnectionBanner({ view, onRetry }: { view: ConnectionReason; onRetry: () => void }) {
  const [changing, setChanging] = useState(false);
  const bridge = globalThis.window?.hobbots?.connection;
  const actions = offered(view);
  return (
    <div
      role="status"
      className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 bg-lantern px-3 py-1.5 text-xs font-bold text-ground"
    >
      <span aria-hidden className="animate-hb-blink">
        ●
      </span>
      <span className="min-w-0 flex-1">
        {view.title} <span className="font-normal">{view.detail}</span>
      </span>
      {actions.includes("openTailscale") && (
        <Button variant="outline" size="xs" className={BUTTON} onClick={() => void bridge?.openTailscale?.()}>
          {copy.openTailscale}
        </Button>
      )}
      {actions.includes("changeAddress") && !changing && (
        <Button variant="outline" size="xs" className={BUTTON} onClick={() => setChanging(true)}>
          {copy.changeAddress}
        </Button>
      )}
      {actions.includes("tryAgain") && (
        <Button
          variant="outline"
          size="xs"
          className={BUTTON}
          onClick={() => {
            void bridge?.retry?.();
            onRetry();
          }}
        >
          {copy.tryNow}
        </Button>
      )}
      {changing && <ChangeAddress address={view.address} onDone={() => setChanging(false)} />}
    </div>
  );
}
