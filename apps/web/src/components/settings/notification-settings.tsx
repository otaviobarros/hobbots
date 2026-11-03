import { Switch } from "@hobbots/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import type { NotificationChoices } from "../../api/client.ts";

const bridge = globalThis.window?.hobbots?.notifications;
const choicesKey = ["desktop", "notifications"] as const;

const ROWS: ReadonlyArray<{ key: keyof NotificationChoices; label: string; note: string }> = [
  {
    key: "requests",
    label: "When a hob needs me",
    note: "Approvals a hob waits on, while no Hobbots window is in front. Recommended.",
  },
  { key: "devices", label: "When a device asks to connect", note: "A phone or computer asking to use this hub." },
  { key: "sound", label: "Play a sound", note: "The system sound with each notification." },
];

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
    <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
      <div className="flex flex-1 flex-col gap-0.5">
        <span id={labelId} className="font-bold">
          {label}
        </span>
        <span className="text-[13px] text-secondary-text">{note}</span>
      </div>
      <Switch aria-labelledby={labelId} checked={checked} disabled={disabled} onCheckedChange={onChange} />
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
      {ROWS.map((row) => (
        <ChoiceRow
          key={row.key}
          label={row.label}
          note={row.note}
          checked={shown?.[row.key] ?? true}
          disabled={!shown || change.isPending || (row.key === "sound" && !shown.requests && !shown.devices)}
          onChange={(on) => change.mutate({ [row.key]: on })}
        />
      ))}
      {(state.isError || change.isError) && (
        <p role="alert" className="m-0 text-sm text-rose">
          Hobbots could not read or change its notifications. Try again.
        </p>
      )}
      <p className="m-0 text-[13px] text-label">macOS can also silence Hobbots in System Settings › Notifications.</p>
    </>
  );
}

/** Settings › This app › Notifications: what the Hobbots app on the hub's Mac notifies about. */
export function NotificationSettings() {
  return bridge ? (
    <NotificationRows notifications={bridge} />
  ) : (
    <p className="m-0 text-secondary-text">
      Notifications come from the Hobbots app on the Mac that runs your hub, and are set there.
    </p>
  );
}
