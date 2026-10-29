import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { loginItemNotice } from "../api/login-item.ts";

const bridge = globalThis.window?.hobbots?.loginItem;
const loginItemKey = ["desktop", "loginItem"] as const;

function LoginItemRow({ loginItem }: { loginItem: NonNullable<typeof bridge> }) {
  const queryClient = useQueryClient();
  const labelId = useId();
  // Read again when the window regains focus, so an approval in System Settings shows up here.
  const state = useQuery({ queryKey: loginItemKey, queryFn: loginItem.get });
  const change = useMutation({
    mutationFn: loginItem.set,
    onSuccess: (next) => queryClient.setQueryData(loginItemKey, next),
  });
  const openSettings = useMutation({ mutationFn: loginItem.openSystemSettings });
  const notice = state.data && loginItemNotice(state.data);

  return (
    <>
      <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
        <div className="flex flex-1 flex-col gap-0.5">
          <span id={labelId} className="font-bold">
            Open Hobbots at login
          </span>
          <span className="text-[13px] text-secondary-text">
            Starts in the background, without the window, so hobs keep working after a restart.
          </span>
        </div>
        <Switch
          aria-labelledby={labelId}
          checked={change.isPending ? change.variables : (state.data?.openAtLogin ?? false)}
          disabled={!state.data || state.data.status === "unavailable" || change.isPending}
          onCheckedChange={(on) => change.mutate(on)}
        />
      </div>
      {notice && (
        <div
          role="status"
          className={`cut flex items-center gap-3 border-2 bg-[#2a2140] px-3 py-2.5 text-sm ${
            notice.tone === "problem" ? "border-rose" : "border-lantern"
          }`}
        >
          <span className="flex-1">{notice.text}</span>
          {state.data?.status === "requires-approval" && (
            <Button variant="outline" size="sm" onClick={() => openSettings.mutate()}>
              Open Login Items
            </Button>
          )}
        </div>
      )}
      {(state.isError || change.isError) && (
        <p role="alert" className="m-0 text-sm text-rose">
          Hobbots could not read or change its login item. Try again, or check System Settings › General › Login Items.
        </p>
      )}
    </>
  );
}

/** Settings › General: how Hobbots starts on this Mac. Only the desktop app can change it. */
export function GeneralSettings() {
  return bridge ? (
    <LoginItemRow loginItem={bridge} />
  ) : (
    <p className="m-0 text-secondary-text">Open at login is set in the Hobbots app on the Mac that runs your hub.</p>
  );
}
