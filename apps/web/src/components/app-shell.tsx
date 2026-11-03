import { Button } from "@hobbots/ui/components/button";
import { Outlet } from "@tanstack/react-router";
import { reasonOf, useDesktopConnection, useFollowDesktopConnection } from "../api/connected-desktop.ts";
import { useHobbotsEvents } from "../api/events.ts";
import { useDeviceAccess } from "../api/live.ts";
import { hubNameOf, isLoopbackHost } from "../lib/hub-name.ts";
import { ConnectionBanner } from "./connection-banner.tsx";
import { DeviceRemoved } from "./device-removed.tsx";
import { HobJump } from "./hob-jump.tsx";
import { useOpenRequests } from "./inbox/use-open-requests.ts";
import { messages } from "./messages.ts";
import { DevicePrompt } from "./pairing/device-prompt.tsx";
import { Rail } from "./rail.tsx";

const copy = messages.deviceAccess;

/**
 * Why the stream is down, in the banner's words. A device on the tailnet that gets no answer at all
 * says the hub may be off or remote access paused (ADR 021); on the hub's own computer, pausing
 * changes nothing, so it only reconnects.
 */
const reconnectingText = (unreachable: boolean) => {
  const hostname = globalThis.location?.hostname ?? "";
  if (!unreachable || isLoopbackHost(hostname)) return copy.reconnecting;
  const hub = hubNameOf(hostname);
  return hub === null ? copy.unreachableNoName : copy.unreachable({ hub });
};

/** The window: its title bar and whichever page fills it, with or without the rail. */
export function AppWindow() {
  // A revoked device sees only that it was removed, whichever page it was on.
  const removed = useDeviceAccess() === "removed";
  return (
    <div className="flex h-screen min-h-[610px] flex-col bg-ground text-text">
      {/* Window chrome: macOS draws the traffic lights over the left of this bar in Electron. */}
      <header className="flex h-[30px] flex-none items-center justify-center bg-deep text-[13px] text-label [-webkit-app-region:drag]">
        Hobbots
      </header>
      {removed ? <DeviceRemoved /> : <Outlet />}
    </div>
  );
}

/** The app once setup is done: live events, the rail and the current page. */
export function AppShell() {
  const connection = useHobbotsEvents();
  const unreachable = useDeviceAccess() === "unreachable";
  // On a connected desktop, the app says why the hub cannot be reached, which a page cannot tell.
  useFollowDesktopConnection();
  const reason = reasonOf(useDesktopConnection().data);
  useOpenRequests();

  return (
    <>
      {reason !== null && <ConnectionBanner view={reason} onRetry={connection.retry} />}
      {reason === null && connection.state === "reconnecting" && (
        <div
          role="status"
          className="flex flex-none items-center gap-2 bg-lantern px-3 py-1.5 text-xs font-bold text-ground"
        >
          <span aria-hidden className="animate-hb-blink">
            ●
          </span>
          <span className="flex-1">{reconnectingText(unreachable)}</span>
          <Button
            variant="outline"
            size="xs"
            className="border-ground text-ground hover:bg-lantern-hover"
            onClick={connection.retry}
          >
            {copy.tryNow}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Rail />
        <Outlet />
      </div>
      <HobJump />
      <DevicePrompt />
    </>
  );
}
