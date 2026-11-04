import { Switch } from "@hobbots/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import type { NotificationChoices } from "../../api/client.ts";
import { messages } from "./messages.ts";

const copy = messages.notifications;

const bridge = globalThis.window?.hobbots?.notifications;
const choicesKey = ["desktop", "notifications"] as const;

const ROWS: ReadonlyArray<keyof NotificationChoices> = ["requests", "finishes", "devices", "sound"];

/** Whether any kind of notification is on, so the sound has something to play with. */
const anyOn = (choices: NotificationChoices) => choices.requests || choices.finishes || choices.devices;

function ChoiceRow({
  label,
  note,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex items-center gap-4 border-b-(length:--edge) border-line py-2.5">
      <Switch aria-labelledby={labelId} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <div className="flex flex-1 flex-col gap-0.5">
        <span id={labelId} className="font-bold">
          {label}
        </span>
        <span className="text-detail text-text-secondary">{note}</span>
      </div>
    </div>
  );
}

function NotificationRows({ notifications }: { notifications: NonNullable<typeof bridge> }) {
  const queryClient = useQueryClient();
  // Local IPC, so it runs while the browser reports being offline.
  const state = useQuery({ queryKey: choicesKey, queryFn: notifications.get, networkMode: "always" });
  const change = useMutation({
    mutationFn: notifications.set,
    networkMode: "always",
    onSuccess: (next) => queryClient.setQueryData(choicesKey, next),
  });
  const shown = state.data && { ...state.data, ...(change.isPending ? change.variables : {}) };

  return (
    <>
      {ROWS.map((key) => (
        <ChoiceRow
          key={key}
          label={copy[key].label}
          note={copy[key].note}
          checked={shown?.[key] ?? true}
          disabled={!shown || change.isPending || (key === "sound" && !anyOn(shown))}
          onChange={(on) => change.mutate({ [key]: on })}
        />
      ))}
      {(state.isError || change.isError) && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.failed}
        </p>
      )}
      <p className="m-0 text-detail text-label">{copy.systemSettings}</p>
    </>
  );
}

/** Settings › This app › Notifications: what the Hobbots app on the hub's Mac notifies about. */
export function NotificationSettings() {
  return bridge ? (
    <NotificationRows notifications={bridge} />
  ) : (
    <p className="m-0 text-text-secondary">{copy.elsewhere}</p>
  );
}
