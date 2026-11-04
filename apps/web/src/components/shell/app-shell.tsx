import { AgentId, ThreadId } from "@hobbots/domain";
import { Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { reasonOf, useDesktopConnection, useFollowDesktopConnection } from "../../api/connected-desktop.ts";
import { useHobbotsEvents } from "../../api/events.ts";
import { useDeviceAccess } from "../../api/live.ts";
import { ArchiveProvider } from "../archive/archive-context.tsx";
import { useOpenRequests } from "../inbox/use-open-requests.ts";
import { DevicePrompt } from "../pairing/device-prompt.tsx";
import { Sidebar } from "../sidebar/sidebar.tsx";
import { ConnectionBanner } from "./connection-banner.tsx";
import { DeviceRemoved } from "./device-removed.tsx";
import { HobJump } from "./hob-jump.tsx";
import { ReconnectingCard, ReconnectingProvider } from "./reconnecting.tsx";

/** A hob's chat or its fresh page, whose header holds the reconnecting card. */
const CHAT_PATH = /^\/hobs\/[^/]+\/(new|threads\/[^/]+)$/;

/** The window's frame: its title bar above whatever fills it, a page or an error screen. */
export function WindowFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen min-h-[610px] flex-col bg-ground text-text-strong">
      {/* Window chrome: macOS draws the traffic lights over the left of this bar in Electron. */}
      <header className="flex h-[30px] flex-none items-center justify-center bg-deep text-detail text-label [-webkit-app-region:drag]">
        Hobbots
      </header>
      {children}
    </div>
  );
}

/** The window: its title bar and whichever page fills it, with or without the sidebar. */
export function AppWindow() {
  // A revoked device sees only that it was removed, whichever page it was on.
  const removed = useDeviceAccess() === "removed";
  return <WindowFrame>{removed ? <DeviceRemoved /> : <Outlet />}</WindowFrame>;
}

/** The app once setup is done: live events, the sidebar and the current page. */
export function AppShell() {
  const connection = useHobbotsEvents();
  const unreachable = useDeviceAccess() === "unreachable";
  // On a connected desktop, the app says why the hub cannot be reached, which a page cannot tell.
  useFollowDesktopConnection();
  const reason = reasonOf(useDesktopConnection().data);
  useOpenRequests();
  const inChat = useRouterState({ select: (s) => CHAT_PATH.test(s.location.pathname) });

  return (
    <>
      {reason !== null && <ConnectionBanner view={reason} onRetry={connection.retry} />}
      <ReconnectingProvider
        value={{ down: reason === null && connection.state === "reconnecting", unreachable, retry: connection.retry }}
      >
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* A chat shows the card under its own header; every other page shows it at the top. */}
            {!inChat && <ReconnectingCard className="mx-6 mt-2.5" />}
            <div className="flex min-h-0 flex-1">
              <ShellArchive>
                <Outlet />
              </ShellArchive>
            </div>
          </div>
        </div>
      </ReconnectingProvider>
      <HobJump />
      <DevicePrompt />
    </>
  );
}

/** Archiving for every page, aware of the hob and chat the address names. */
function ShellArchive({ children }: { children: React.ReactNode }) {
  const params = useParams({ strict: false }) as { hobId?: string; threadId?: string };
  return (
    <ArchiveProvider
      hobId={params.hobId === undefined ? undefined : AgentId.make(params.hobId)}
      threadId={params.threadId === undefined ? undefined : ThreadId.make(params.threadId)}
    >
      {children}
    </ArchiveProvider>
  );
}
