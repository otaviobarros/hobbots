import { Button } from "@hobbots/ui/components/button";
import { Outlet } from "@tanstack/react-router";
import { useHobbotsEvents } from "../api/events.ts";
import { HobJump } from "./hob-jump.tsx";
import { useRequestNotices } from "./inbox/use-request-notices.ts";
import { Rail } from "./rail.tsx";

/** The window: its title bar and whichever page fills it, with or without the rail. */
export function AppWindow() {
  return (
    <div className="flex h-screen min-h-[610px] flex-col bg-ground text-text">
      {/* Window chrome: macOS draws the traffic lights over the left of this bar in Electron. */}
      <header className="flex h-[30px] flex-none items-center justify-center bg-deep text-[13px] text-label [-webkit-app-region:drag]">
        Hobbots
      </header>
      <Outlet />
    </div>
  );
}

/** The app once setup is done: live events, the rail and the current page. */
export function AppShell() {
  const connection = useHobbotsEvents(useRequestNotices());

  return (
    <>
      {connection.state === "reconnecting" && (
        <div
          role="status"
          className="flex flex-none items-center gap-2 bg-lantern px-3 py-1.5 text-xs font-bold text-ground"
        >
          <span aria-hidden className="animate-hb-blink">
            ●
          </span>
          <span className="flex-1">
            Reconnecting to Hobbots… Messages you send wait here and go out when it is back.
          </span>
          <Button
            variant="outline"
            size="xs"
            className="border-ground text-ground hover:bg-lantern-hover"
            onClick={connection.retry}
          >
            Try now
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Rail />
        <Outlet />
      </div>
      <HobJump />
    </>
  );
}
