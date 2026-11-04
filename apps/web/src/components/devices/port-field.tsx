import { DEFAULT_HUB_PORT, HubPort } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Schema } from "effect";
import { useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useUpdateRemoteAccess } from "../../api/remote-access.ts";
import { messages } from "../messages.ts";

const copy = messages.remoteAccess.port;

const isHubPort = Schema.is(HubPort);

/** The port typed so far, or null when it is not one the hub may listen on. */
export const typedPort = (text: string): number | null => {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return isHubPort(port) ? port : null;
};

/** Why the port did not change, in the user's words. */
const failure = (error: unknown, port: number): string =>
  error instanceof ApiError && error.tag === "PortUnavailable"
    ? copy.unavailable({ port, detail: String(error.fields.detail ?? "") })
    : messages.remoteAccess.failed;

/**
 * The hub's port in Settings › Devices. Changing it moves the hub's loopback and tailnet listeners at
 * once; a page the hub serves follows it, and other devices need the new address (ADR 021).
 */
export function PortField({ port }: { port: number }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const change = useUpdateRemoteAccess();
  const text = draft ?? String(port);
  const next = typedPort(text);
  const invalid = text !== "" && next === null;
  return (
    <form
      className="flex flex-col gap-1.5 pt-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (next === null || next === port) return;
        change.mutate({ port: next }, { onSuccess: () => setDraft(null) });
      }}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor={id} className="text-sm font-bold">
          {copy.label}
        </label>
        <input
          id={id}
          value={text}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          aria-invalid={invalid}
          aria-describedby={`${id}-note`}
          onChange={(event) => {
            change.reset();
            setDraft(event.target.value.replace(/\D/g, ""));
          }}
          className="w-20 border-2 border-control bg-deep px-2 py-1 font-mono text-sm text-text-strong focus-ring"
        />
        {next !== null && next !== port && (
          <Button type="submit" variant="outline" size="xs" disabled={change.isPending}>
            {change.isPending ? copy.saving : copy.save}
          </Button>
        )}
      </div>
      <span id={`${id}-note`} className="text-[13px] text-label">
        {copy.note({ fallback: DEFAULT_HUB_PORT })}
      </span>
      {(invalid || change.isError) && (
        <span role="alert" className="text-sm text-rose">
          {invalid ? copy.invalid : failure(change.error, next ?? port)}
        </span>
      )}
    </form>
  );
}
