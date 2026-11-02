import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId } from "react";
import { loginItemNotice } from "../api/login-item.ts";

const bridge = globalThis.window?.hobbots?.loginItem;
const loginItemKey = ["desktop", "loginItem"] as const;
const keepRunningBridge = globalThis.window?.hobbots?.keepRunning;
const keepRunningKey = ["desktop", "keepRunning"] as const;

function LoginItemRow({ loginItem }: { loginItem: NonNullable<typeof bridge> }) {
  const queryClient = useQueryClient();
  const labelId = useId();
  // Local IPC, so it runs while the browser reports being offline.
  const state = useQuery({ queryKey: loginItemKey, queryFn: loginItem.get, networkMode: "always" });
  const update = (next: Awaited<ReturnType<typeof loginItem.get>>) => queryClient.setQueryData(loginItemKey, next);
  const change = useMutation({ mutationFn: loginItem.set, networkMode: "always", onSuccess: update });
  const openSettings = useMutation({
    mutationFn: loginItem.openSystemSettings,
    networkMode: "always",
    onSuccess: update,
  });
  // Read again whenever the window regains focus, so an approval in System Settings shows up here.
  // Focus, not visibility: the window stays visible beside System Settings.
  const { refetch } = state;
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);
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
          className={`cut flex items-center gap-3 border-2 bg-notice px-3 py-2.5 text-sm ${
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

function KeepRunningRow({ keepRunning }: { keepRunning: NonNullable<typeof keepRunningBridge> }) {
  const queryClient = useQueryClient();
  const labelId = useId();
  // Local IPC, so it runs while the browser reports being offline.
  const state = useQuery({ queryKey: keepRunningKey, queryFn: keepRunning.get, networkMode: "always" });
  const change = useMutation({
    mutationFn: keepRunning.set,
    networkMode: "always",
    onSuccess: (on) => queryClient.setQueryData(keepRunningKey, on),
  });
  const on = change.isPending ? change.variables : (state.data ?? true);

  return (
    <>
      <div className="flex items-center gap-4 border-b-2 border-line py-2.5">
        <div className="flex flex-1 flex-col gap-0.5">
          <span id={labelId} className="font-bold">
            Keep running in the menu bar when the window closes
          </span>
          <span className="text-[13px] text-secondary-text">
            Hobs keep working after you close the window. Reopen it from the menu-bar icon.
          </span>
        </div>
        <Switch
          aria-labelledby={labelId}
          checked={on}
          disabled={state.data === undefined || change.isPending}
          onCheckedChange={(next) => change.mutate(next)}
        />
      </div>
      {state.data !== undefined && !on && (
        <p role="status" className="cut m-0 border-2 border-lantern bg-notice px-3 py-2.5 text-sm leading-[1.45]">
          Closing the window will quit Hobbots. Hobs stop what they are doing, and their work is picked up again as
          interrupted next time. If hobs are busy, Hobbots asks before quitting.
        </p>
      )}
      {(state.isError || change.isError) && (
        <p role="alert" className="m-0 text-sm text-rose">
          Hobbots could not read or change this setting. Try again.
        </p>
      )}
      <p className="m-0 text-[13px] text-label">
        Quitting Hobbots from the menu-bar icon or with ⌘Q stops the server it started either way.
      </p>
    </>
  );
}

/** Settings › General: how Hobbots starts and stays running on this Mac. Only the desktop app can change it. */
export function GeneralSettings() {
  return bridge || keepRunningBridge ? (
    <>
      {bridge && <LoginItemRow loginItem={bridge} />}
      {keepRunningBridge && <KeepRunningRow keepRunning={keepRunningBridge} />}
    </>
  ) : (
    <p className="m-0 text-secondary-text">
      Open at login and the menu bar are set in the Hobbots app on the Mac that runs your hub.
    </p>
  );
}
