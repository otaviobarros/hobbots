import { AgentId, AttemptId, TaskId, ThreadId } from "@hobbots/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { keptDraftOrStored } from "./api/first-hob.ts";
import { needsPairing } from "./api/pairing.ts";
import { agentsQuery, archivedAgentsQuery, threadsQuery } from "./api/queries.ts";
import { opensWelcome, readSetup, setupDone } from "./api/setup.ts";
import { AppShell, AppWindow } from "./components/app-shell.tsx";
import { ArchivedHobView } from "./components/archived-hobs.tsx";
import { ArchivedThreadList } from "./components/archived-threads/archived-threads.tsx";
import { HobPage } from "./components/hob-page/hob-page.tsx";
import { type HobPageTab, isHobPageTab } from "./components/hob-page/hob-page-model.ts";
import { HobProfile } from "./components/hob-profile.tsx";
import { HobsLayout } from "./components/hobs-layout.tsx";
import { Home } from "./components/home.tsx";
import { type InboxTab, isInboxTab } from "./components/inbox/inbox-items.ts";
import { InboxPage } from "./components/inbox/inbox-page.tsx";
import { OnboardingFirstHob } from "./components/onboarding-first-hob.tsx";
import { OnboardingProviders } from "./components/onboarding-providers.tsx";
import { OnboardingFolders, OnboardingSafety } from "./components/onboarding-safety.tsx";
import { OnboardingReady } from "./components/onboarding-summon.tsx";
import { ArchivedHobsPage, SettingsPage } from "./components/pages.tsx";
import { PairingScreen } from "./components/pairing/pairing-screen.tsx";
import { SetupRemoteAccess } from "./components/setup-remote-access.tsx";
import { Summon } from "./components/summon.tsx";
import { UsagePage } from "./components/usage/usage-page.tsx";
import { Welcome } from "./components/welcome.tsx";
import { WhereHobbotsRuns } from "./components/where-hobbots-runs.tsx";
import type { WorkbenchSearch } from "./components/workbench/use-workbench.ts";
import { isWorkbenchTab } from "./components/workbench/workbench-model.ts";
import { readStored, writeStored } from "./lib/storage.ts";
import { isUsagePeriod } from "./lib/usage.ts";

const lastHobKey = "lastHob";

const PAIR_PATH = "/pair";

// A browser without a device on the hub asks for one before anything else (ADR 021).
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ location, context }) => {
    if (location.pathname !== PAIR_PATH && (await needsPairing(context.queryClient))) {
      throw redirect({ to: PAIR_PATH });
    }
  },
  component: AppWindow,
});

// The pairing screen: ask once, wait with the matching code, and open Hobbots once allowed.
const pairRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "pair",
  beforeLoad: async ({ context }) => {
    if (!(await needsPairing(context.queryClient))) throw redirect({ to: "/" });
  },
  component: PairingScreen,
});

// A new installation opens on Welcome, outside the app shell, until setup is done:
// Welcome → Where Hobbots runs → other devices → providers → first hob → safety → folders → summon → Home.
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

// Run Hobbots on this computer asks next whether other devices may use it too (ADR 021).
const setupRemoteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/remote",
  beforeLoad: leaveSetupWhenDone,
  component: SetupRemoteAccess,
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

// Every page after setup shares the sidebar.
const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: "shell", component: AppShell });

// Home is the landing page; each hob is one click away on its own page.
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

// A hob's own page: its hero, its chats and its history. `?tab=history` opens History.
const hobRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId",
  validateSearch: (search: Record<string, unknown>): { tab?: HobPageTab | undefined } => ({
    tab: isHobPageTab(search.tab) && search.tab !== "chats" ? search.tab : undefined,
  }),
  beforeLoad: ({ params }) => writeStored(lastHobKey, params.hobId),
  component: function HobPageRoute() {
    const params = hobRoute.useParams();
    const { tab } = hobRoute.useSearch();
    return (
      <HobsLayout
        hobId={AgentId.make(params.hobId)}
        aside={null}
        main={(props) => <HobPage key={params.hobId} {...props} tab={tab ?? "chats"} />}
      />
    );
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

// The hob's archived threads, most recently archived first, in place of the chat (CH-009).
const archivedThreadsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/archived",
  beforeLoad: ({ params }) => writeStored(lastHobKey, params.hobId),
  component: function ArchivedThreadsPage() {
    const params = archivedThreadsRoute.useParams();
    return <HobsLayout hobId={AgentId.make(params.hobId)} main={(props) => <ArchivedThreadList {...props} />} />;
  },
});

// `?message=` names a message to scroll to, as a search result does; `?task=` a Task to open in
// the drawer beside the chat; `?bench=` a Task whose Workbench shows in the chat's place, with its
// `tab`, `attempt`, the `file` a tab shows first and `chat` when its chat drawer is open (ADR 023).
const threadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/threads/$threadId",
  validateSearch: (
    search: Record<string, unknown>,
  ): { message?: string | undefined; task?: string | undefined } & WorkbenchSearch => ({
    message: typeof search.message === "string" ? search.message : undefined,
    task: typeof search.task === "string" ? search.task : undefined,
    bench: typeof search.bench === "string" ? search.bench : undefined,
    tab: isWorkbenchTab(search.tab) ? search.tab : undefined,
    attempt: typeof search.attempt === "string" ? search.attempt : undefined,
    file: typeof search.file === "string" ? search.file : undefined,
    chat: search.chat === "open" ? "open" : undefined,
  }),
  beforeLoad: ({ params }) => writeStored(lastHobKey, params.hobId),
  component: function ThreadPage() {
    const params = threadRoute.useParams();
    const { message, task, bench, tab, attempt, file, chat } = threadRoute.useSearch();
    return (
      <HobsLayout
        hobId={AgentId.make(params.hobId)}
        threadId={ThreadId.make(params.threadId)}
        focusMessageId={message}
        taskId={task === undefined ? undefined : TaskId.make(task)}
        workbench={
          bench === undefined
            ? undefined
            : {
                taskId: TaskId.make(bench),
                tab: tab ?? "summary",
                attemptId: attempt === undefined ? undefined : AttemptId.make(attempt),
                file,
                from: task === bench ? "drawer" : "chat",
                chatOpen: chat === "open",
              }
        }
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
// `?days=` picks the period: the last 7 days, or 30. The router reads the number as a number.
const usageRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "usage",
  validateSearch: (search: Record<string, unknown>): { days?: number | undefined } => ({
    days: isUsagePeriod(String(search.days)) ? Number(search.days) : undefined,
  }),
  component: function Usage() {
    const { days } = usageRoute.useSearch();
    return <UsagePage days={days === 30 ? "30" : "7"} />;
  },
});
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
  pairRoute,
  welcomeRoute,
  setupWhereRoute,
  setupRemoteRoute,
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
    archivedThreadsRoute,
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
