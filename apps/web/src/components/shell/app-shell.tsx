import { AgentId, ThreadId } from "@hobbots/domain";
import { Outlet, useParams, useRouterState } from "@tanstack/react-router";
import { reasonOf, useDesktopConnection, useFollowDesktopConnection } from "../../api/connected-desktop.ts";
import { useHobbotsEvents } from "../../api/events.ts";
import { useDeviceAccess } from "../../api/live.ts";
import { ArchiveProvider } from "../archive/archive-context.tsx";
import { useOpenRequests } from "../inbox/use-open-requests.ts";
import { MoveOnProvider } from "../move-on/move-on.tsx";
import { DevicePrompt } from "../pairing/device-prompt.tsx";
import { Sidebar } from "../sidebar/sidebar.tsx";
import { ConnectionBanner } from "./connection-banner.tsx";
import { DeviceRemoved } from "./device-removed.tsx";
import { HobJump } from "./hob-jump.tsx";
import { HubReadCard } from "./hub-read-card.tsx";
import { ReconnectingCard, ReconnectingProvider } from "./reconnecting.tsx";
import { titleStrip, windowBody, windowFrame } from "./window-classes.ts";

/** A hob's chat or its fresh page, whose header holds the reconnecting card. */
const CHAT_PATH = /^\/hobs\/[^/]+\/(chat|threads\/[^/]+)$/;

/**
 * The desktop window's title bar, which macOS draws the traffic lights over and the window drags by.
 * A browser tab has its own, so the strip shows only in the desktop app, whose preload sets `window.hobbots`.
 */
function TitleStrip() {
  if (window.hobbots === undefined) return null;
  return <header className={titleStrip}>Hobbots</header>;
}

/** The window's frame: the desktop title bar above whatever fills it, a page or an error screen. */
export function WindowFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className={windowFrame}>
      <TitleStrip />
      {children}
    </div>
  );
}

/** The window: the desktop title bar and whichever page fills it, with or without the sidebar. */
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
  const down = reason !== null || connection.state === "reconnecting";

  return (
    <>
      {reason !== null && <ConnectionBanner view={reason} onRetry={connection.retry} />}
      <ReconnectingProvider
        value={{ down: reason === null && connection.state === "reconnecting", unreachable, retry: connection.retry }}
      >
        <div className={windowBody}>
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* A chat shows the card under its own header; every other page shows it at the top. */}
            {!inChat && <ReconnectingCard className="mx-6 mt-2.5" />}
            <HubReadCard hidden={down} className="mx-6 mt-2.5" />
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

/** Archiving and its toasts for every page, aware of the hob and chat the address names. */
function ShellArchive({ children }: { children: React.ReactNode }) {
  const params = useParams({ strict: false }) as { hobId?: string; threadId?: string };
  return (
    <ArchiveProvider
      hobId={params.hobId === undefined ? undefined : AgentId.make(params.hobId)}
      threadId={params.threadId === undefined ? undefined : ThreadId.make(params.threadId)}
    >
      <MoveOnProvider>{children}</MoveOnProvider>
    </ArchiveProvider>
  );
}
