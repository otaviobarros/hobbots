import { type RemoteAccessStatus, SERVE_OFF_ARGS, serveOnArgs, tailscaleCommand } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useServe, useUpdateRemoteAccess } from "../../api/remote-access.ts";
import { useCopy } from "../../lib/use-copy.ts";
import { messages } from "../messages.ts";

const copy = messages.remoteAccess.https;

/** What Settings asks of `tailscale serve`: to forward HTTPS to the hub, or to remove that. */
type ServeAsk = "forward" | "remove";

/**
 * What Settings asks of `tailscale serve` now (ADR 021), or null when serve already matches the
 * switch or the hub cannot say: forward while HTTPS is on and serve does not forward yet, and
 * remove while serve still forwards after HTTPS or remote access was turned off.
 */
export const serveAsk = (status: RemoteAccessStatus): ServeAsk | null => {
  const { enabled, listening, forwarding } = status.https;
  if (status.enabled && enabled) return listening && forwarding === false ? "forward" : null;
  return forwarding === true ? "remove" : null;
};

/** Why `tailscale serve` did not run, in the user's words. */
const serveFailure = (error: unknown): string =>
  error instanceof ApiError && error.tag === "ServeFailed"
    ? copy.failed({ detail: String(error.fields.detail ?? "") })
    : copy.failedPlain;

/**
 * The `tailscale serve` command to run on the hub, with Copy, and Run it for me…, which asks first
 * in place. Not now or Escape takes the question back with focus on Run it for me….
 */
function ServeCommand({ ask, status }: { ask: ServeAsk; status: RemoteAccessStatus }) {
  const command = tailscaleCommand(ask === "forward" ? serveOnArgs(status.https.port) : SERVE_OFF_ARGS);
  const [asking, setAsking] = useState(false);
  const [copied, copyText] = useCopy();
  const serve = useServe();
  const notNowButton = useRef<HTMLButtonElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) notNowButton.current?.focus();
    else if (wasAsking.current) runButton.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  const notNow = () => {
    serve.reset();
    setAsking(false);
  };
  const consent = ask === "forward" ? copy.consentOn({ command }) : copy.consentOff({ command });

  return (
    <div className="flex animate-hb-in flex-col gap-2">
      <p className="m-0 flex items-start gap-2 text-sm">
        <span aria-hidden className="mt-1.5 size-2 flex-none bg-lantern" />
        <span>{ask === "forward" ? copy.notServing : copy.leftOver}</span>
      </p>
      <div className="cut flex flex-wrap items-center gap-2.5 border-2 border-control bg-deep px-3 py-2">
        <code className="min-w-0 flex-1 font-mono text-sm text-moonlight wrap-anywhere">{command}</code>
        <Button variant="outline" size="xs" onClick={() => copyText(command)}>
          {copied === "idle"
            ? messages.remoteAccess.copy
            : copied === "copied"
              ? messages.remoteAccess.copied
              : messages.remoteAccess.copyFailed}
        </Button>
        {!asking && (
          <Button ref={runButton} variant="outline" size="xs" onClick={() => setAsking(true)}>
            {copy.run}
          </Button>
        )}
        <span aria-live="polite" className="sr-only">
          {copied === "copied"
            ? messages.remoteAccess.copied
            : copied === "failed"
              ? messages.remoteAccess.copyFailed
              : ""}
        </span>
      </div>
      {asking && (
        <fieldset
          aria-label={consent}
          disabled={serve.isPending}
          className="cut m-0 flex animate-hb-in flex-wrap items-center gap-2 border-2 border-solid border-lantern bg-deep px-3 py-2.5"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !serve.isPending) {
              event.stopPropagation();
              notNow();
            }
          }}
        >
          <span className="flex-1 text-sm">{consent}</span>
          {serve.isError && (
            <span role="alert" className="basis-full text-sm text-rose wrap-anywhere">
              {serveFailure(serve.error)}
            </span>
          )}
          <Button ref={notNowButton} variant="outline" size="sm" onClick={notNow}>
            {copy.notNow}
          </Button>
          <Button size="sm" onClick={() => serve.mutate(ask === "forward", { onSuccess: () => setAsking(false) })}>
            {serve.isPending ? copy.running : copy.confirm}
          </Button>
        </fieldset>
      )}
    </div>
  );
}

/**
 * What Settings says about `tailscale serve` while remote access is off: the command that removes
 * it while serve still forwards to the hub. Null while remote access is on or nothing is left over.
 */
export function ServeLeftOver({ status }: { status: RemoteAccessStatus }) {
  return !status.enabled && serveAsk(status) === "remove" ? <ServeCommand ask="remove" status={status} /> : null;
}

/**
 * Settings › Devices, while remote access is on: the "Use HTTPS through Tailscale" switch, and the
 * `tailscale serve` command it needs, which Hobbots runs only after you consent (ADR 021).
 */
export function HttpsSettings({ status }: { status: RemoteAccessStatus }) {
  const labelId = useId();
  const change = useUpdateRemoteAccess();
  const on = (change.isPending ? change.variables.https : undefined) ?? status.https.enabled;
  const ask = serveAsk(status);
  return (
    <>
      <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
        <div className="flex flex-1 flex-col gap-0.5">
          <span id={labelId} className="font-bold">
            {copy.switchLabel}
          </span>
          <span className="text-[13px] text-text-secondary">{copy.note}</span>
        </div>
        <Switch
          aria-labelledby={labelId}
          checked={on}
          disabled={change.isPending}
          onCheckedChange={(https) => change.mutate({ https })}
        />
      </div>
      {status.https.enabled && status.https.detail !== null && (
        <p className="m-0 flex items-start gap-2 text-sm">
          <span aria-hidden className="mt-1.5 size-2 flex-none bg-lantern" />
          <span>{copy.cannotListen({ detail: status.https.detail })}</span>
        </p>
      )}
      {status.https.enabled && status.https.listening && status.https.forwarding === true && (
        <p className="m-0 flex animate-hb-in items-center gap-2 text-sm">
          <span aria-hidden className="size-2 flex-none bg-mint" />
          <span>{copy.serving}</span>
        </p>
      )}
      {ask !== null && <ServeCommand key={ask} ask={ask} status={status} />}
      {change.isError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {messages.remoteAccess.failed}
        </p>
      )}
    </>
  );
}
