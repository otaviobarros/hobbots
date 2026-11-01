import { AgentId, ThreadId } from "@hobbots/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { keptDraftOrStored } from "./api/first-hob.ts";
import { agentsQuery, archivedAgentsQuery, threadsQuery } from "./api/queries.ts";
import { opensWelcome, readSetup, setupDone } from "./api/setup.ts";
import { AppShell, AppWindow } from "./components/app-shell.tsx";
import { ArchivedHobView } from "./components/archived-hobs.tsx";
import { HobProfile } from "./components/hob-profile.tsx";
import { HobsLayout } from "./components/hobs-layout.tsx";
import { Home } from "./components/home.tsx";
import { type InboxTab, isInboxTab } from "./components/inbox/inbox-items.ts";
import { InboxPage } from "./components/inbox/inbox-page.tsx";
import { OnboardingFirstHob } from "./components/onboarding-first-hob.tsx";
import { OnboardingProviders } from "./components/onboarding-providers.tsx";
import { OnboardingFolders, OnboardingSafety } from "./components/onboarding-safety.tsx";
import { OnboardingReady } from "./components/onboarding-summon.tsx";
import { ArchivedHobsPage, SettingsPage, UsagePage } from "./components/pages.tsx";
import { Summon } from "./components/summon.tsx";
import { Welcome } from "./components/welcome.tsx";
import { WhereHobbotsRuns } from "./components/where-hobbots-runs.tsx";
import { readStored, writeStored } from "./lib/storage.ts";

const lastHobKey = "lastHob";
const lastThreadKey = (hobId: string) => `lastThread.${hobId}`;

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: AppWindow,
});

// A new installation opens on Welcome, outside the app shell, until setup is done:
// Welcome → Where Hobbots runs → providers → first hob → safety → folders → summon → Home.
// Once setup is done, each of them opens Home.
const leaveSetupWhenDone = async ({ context }: { context: { queryClient: QueryClient } }) => {
  if (setupDone(await readSetup(context.queryClient))) throw redirect({ to: "/" });
};

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "welcome",
  beforeLoad: leaveSetupWhenDone,
  component: Welcome,
});

const setupWhereRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/where",
  beforeLoad: leaveSetupWhenDone,
  component: WhereHobbotsRuns,
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/providers",
  beforeLoad: leaveSetupWhenDone,
  component: OnboardingProviders,
});

const firstHobRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/hob",
  beforeLoad: leaveSetupWhenDone,
  component: OnboardingFirstHob,
});

// The steps after the first hob build on its draft, so without one they start from that step.
const afterFirstHob = async (args: { context: { queryClient: QueryClient } }) => {
  await leaveSetupWhenDone(args);
  if (keptDraftOrStored() === null) throw redirect({ to: "/setup/hob" });
};

const safetyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/safety",
  beforeLoad: afterFirstHob,
  component: OnboardingSafety,
});

const foldersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/folders",
  beforeLoad: afterFirstHob,
  component: OnboardingFolders,
});

const readyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/ready",
  beforeLoad: afterFirstHob,
  component: OnboardingReady,
});

// Every page after setup shares the rail.
const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: "shell", component: AppShell });

// Home is the landing page; the chat is one click away and opens on the last thread.
const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    if (opensWelcome(await readSetup(context.queryClient))) throw redirect({ to: "/welcome" });
  },
  component: Home,
});

const hobsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs",
  beforeLoad: async ({ context }) => {
    const hobs = await context.queryClient.ensureQueryData(agentsQuery);
    const remembered = readStored<string | null>(lastHobKey, null);
    const target = hobs.find((h) => h.id === remembered) ?? hobs[0];
    if (target) throw redirect({ to: "/hobs/$hobId", params: { hobId: target.id } });
  },
  component: () => <section className="grid flex-1 place-items-center text-label">No hobs yet.</section>,
});

// Opening a hob restores its last selected thread, or its most recent one, or a fresh page.
const hobRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId",
  beforeLoad: async ({ context, params }) => {
    const hobId = AgentId.make(params.hobId);
    const threads = await context.queryClient.ensureQueryData(threadsQuery(hobId));
    const remembered = readStored<string | null>(lastThreadKey(hobId), null);
    const target = threads.find((t) => t.id === remembered) ?? threads[0];
    if (target) throw redirect({ to: "/hobs/$hobId/threads/$threadId", params: { hobId, threadId: target.id } });
    throw redirect({ to: "/hobs/$hobId/new", params: { hobId } });
  },
});

const newThreadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/new",
  beforeLoad: ({ params }) => writeStored(lastHobKey, params.hobId),
  component: function NewThreadPage() {
    const params = newThreadRoute.useParams();
    return <HobsLayout hobId={AgentId.make(params.hobId)} />;
  },
});

// `?message=` names a message to scroll to, as a search result does.
const threadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/threads/$threadId",
  validateSearch: (search: Record<string, unknown>): { message?: string | undefined } => ({
    message: typeof search.message === "string" ? search.message : undefined,
  }),
  beforeLoad: ({ params }) => {
    writeStored(lastHobKey, params.hobId);
    writeStored(lastThreadKey(params.hobId), params.threadId);
  },
  component: function ThreadPage() {
    const params = threadRoute.useParams();
    const { message } = threadRoute.useSearch();
    return (
      <HobsLayout
        hobId={AgentId.make(params.hobId)}
        threadId={ThreadId.make(params.threadId)}
        focusMessageId={message}
      />
    );
  },
});

// The hob's profile: its instructions, brain, Pause / Wake and Retire.
const profileRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/profile",
  component: function ProfilePage() {
    const params = profileRoute.useParams();
    return <HobProfile key={params.hobId} hobId={AgentId.make(params.hobId)} />;
  },
});

// Summon names the new hob apart from the hobs already there, so it loads them first.
const summonRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "summon",
  beforeLoad: ({ context }) => context.queryClient.ensureQueryData(agentsQuery),
  component: Summon,
});

// `?tab=` picks Needs you, All or History and `?request=` the request shown beside the list.
const inboxRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "inbox",
  validateSearch: (search: Record<string, unknown>): { tab?: InboxTab | undefined; request?: string | undefined } => ({
    tab: isInboxTab(search.tab) ? search.tab : undefined,
    request: typeof search.request === "string" ? search.request : undefined,
  }),
  component: function Inbox() {
    const { tab, request } = inboxRoute.useSearch();
    return <InboxPage tab={tab ?? "needs"} requestId={request} />;
  },
});
const usageRoute = createRoute({ getParentRoute: () => shellRoute, path: "usage", component: UsagePage });
const settingsRoute = createRoute({ getParentRoute: () => shellRoute, path: "settings", component: SettingsPage });
// Settings › Archived hobs: retired hobs, whose threads open read-only (AG-006).
const archivedRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings/archived",
  component: ArchivedHobsPage,
});

// A retired hob opens on its most recent thread.
const archivedHobRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings/archived/$hobId",
  beforeLoad: async ({ context, params }) => {
    const hobId = AgentId.make(params.hobId);
    const [threads, archived] = await Promise.all([
      context.queryClient.ensureQueryData(threadsQuery(hobId)).catch(() => []),
      context.queryClient.ensureQueryData(archivedAgentsQuery),
    ]);
    // Only a retired hob's threads open here; any other id shows that it is not archived.
    if (!archived.some((hob) => hob.id === hobId)) return;
    const target = threads[0];
    if (target) {
      throw redirect({ to: "/settings/archived/$hobId/threads/$threadId", params: { hobId, threadId: target.id } });
    }
  },
  component: function ArchivedHobPage() {
    const params = archivedHobRoute.useParams();
    return <ArchivedHobView hobId={AgentId.make(params.hobId)} />;
  },
});

const archivedThreadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings/archived/$hobId/threads/$threadId",
  component: function ArchivedThreadPage() {
    const params = archivedThreadRoute.useParams();
    return <ArchivedHobView hobId={AgentId.make(params.hobId)} threadId={ThreadId.make(params.threadId)} />;
  },
});

const routeTree = rootRoute.addChildren([
  welcomeRoute,
  setupWhereRoute,
  providersRoute,
  firstHobRoute,
  safetyRoute,
  foldersRoute,
  readyRoute,
  shellRoute.addChildren([
    homeRoute,
    hobsRoute,
    hobRoute,
    newThreadRoute,
    threadRoute,
    profileRoute,
    summonRoute,
    inboxRoute,
    usageRoute,
    settingsRoute,
    archivedRoute,
    archivedHobRoute,
    archivedThreadRoute,
  ]),
]);

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({
    routeTree,
    // Hash history keeps deep links working when Electron loads the UI from file://.
    history: createHashHistory(),
    context: { queryClient },
    defaultPreloadStaleTime: 0,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
