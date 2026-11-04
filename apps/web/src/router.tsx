import { AgentId, AttemptId, type HistoryFilter, TaskId, ThreadId } from "@hobbots/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { keptDraftOrStored } from "./api/first-hob.ts";
import { needsPairing } from "./api/pairing.ts";
import { agentsQuery } from "./api/queries.ts";
import { opensWelcome, readSetup, setupDone } from "./api/setup.ts";
import { AppShell, AppWindow } from "./components/app-shell.tsx";
import { type ArchiveTab, isArchiveTab } from "./components/archive-page/archive-model.ts";
import { ArchiveNotices } from "./components/archive-page/archive-notices.tsx";
import { ArchivePage } from "./components/archive-page/archive-page.tsx";
import { ArchivedChatPage, RetiredChatPage, RetiredHobPage } from "./components/archive-page/archive-read.tsx";
import { HobPage } from "./components/hob-page/hob-page.tsx";
import { type HobPageTab, isHistoryFilter, isHobPageTab } from "./components/hob-page/hob-page-model.ts";
import { HobProfile } from "./components/hob-profile.tsx";
import { HobsLayout } from "./components/hobs-layout.tsx";
import { HobsPage } from "./components/hobs-page/hobs-page.tsx";
import { type HobFilter, isHobFilter } from "./components/hobs-page/hobs-page-model.ts";
import { Home } from "./components/home.tsx";
import { type InboxTab, isInboxTab } from "./components/inbox/inbox-items.ts";
import { InboxPage } from "./components/inbox/inbox-page.tsx";
import { OnboardingFirstHob } from "./components/onboarding-first-hob.tsx";
import { OnboardingProviders } from "./components/onboarding-providers.tsx";
import { OnboardingFolders, OnboardingSafety } from "./components/onboarding-safety.tsx";
import { OnboardingReady } from "./components/onboarding-summon.tsx";
import { PairingScreen } from "./components/pairing/pairing-screen.tsx";
import { type ConnectionsTab, isConnectionsTab, isSettingsSection } from "./components/settings/sections.ts";
import { SettingsPage } from "./components/settings/settings-page.tsx";
import { SetupRemoteAccess } from "./components/setup-remote-access.tsx";
import { ArrivedPage } from "./components/summon/arrived.tsx";
import { Summon } from "./components/summon/summon.tsx";
import { parseStep, type SummonStep } from "./components/summon/summon-model.ts";
import { UsagePage } from "./components/usage/usage-page.tsx";
import { Welcome } from "./components/welcome.tsx";
import { WhereHobbotsRuns } from "./components/where-hobbots-runs.tsx";
import type { WorkbenchSearch } from "./components/workbench/use-workbench.ts";
import { isWorkbenchTab } from "./components/workbench/workbench-model.ts";
import { isUsagePeriod } from "./lib/usage.ts";

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
// Welcome → Where Hobbots runs → providers → first hob → safety → folders → other devices → summon → Home.
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

// After Folders, setup asks whether other devices may use Hobbots too (ADR 021). It can be skipped.
const setupRemoteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup/remote",
  beforeLoad: afterFirstHob,
  component: SetupRemoteAccess,
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

// Your hobs: every hob as a card. `?show=` narrows it to the hobs that need you, work or rest.
const hobsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs",
  validateSearch: (search: Record<string, unknown>): { show?: HobFilter | undefined } => ({
    show: isHobFilter(search.show) && search.show !== "all" ? search.show : undefined,
  }),
  component: function YourHobs() {
    const { show } = hobsRoute.useSearch();
    return <HobsPage filter={show ?? "all"} />;
  },
});

// A hob's own page: its hero, its chats and its history. `?tab=history` opens History.
const hobRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId",
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: HobPageTab | undefined; show?: HistoryFilter | undefined; q?: string | undefined } => ({
    tab: isHobPageTab(search.tab) && search.tab !== "chats" ? search.tab : undefined,
    show: isHistoryFilter(search.show) && search.show !== "all" ? search.show : undefined,
    // A link can open the Chats tab already searching, such as from a chat's own search.
    q: typeof search.q === "string" && search.q.trim() !== "" ? search.q : undefined,
  }),
  component: function HobPageRoute() {
    const params = hobRoute.useParams();
    const { tab, show, q } = hobRoute.useSearch();
    return (
      <HobsLayout
        hobId={AgentId.make(params.hobId)}
        aside={null}
        main={(props) => (
          <HobPage key={params.hobId} {...props} tab={tab ?? "chats"} show={show ?? "all"} query={q ?? ""} />
        )}
      />
    );
  },
});

const newThreadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/new",
  component: function NewThreadPage() {
    const params = newThreadRoute.useParams();
    return <HobsLayout hobId={AgentId.make(params.hobId)} />;
  },
});

// A hob's archived threads now live in the Archive, narrowed to that hob (CH-009).
const archivedThreadsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/archived",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/archive", search: { hob: params.hobId }, replace: true });
  },
});

// `?message=` names a message to scroll to, as a search result does; `?quest=` a request's Quest,
// by its top Task, to open in the work sheet over the chat, and `?task=` a Task to open there; `?bench=` a Task whose Workbench shows in the chat's place, with its
// `tab`, `attempt`, the `file` a tab shows first and `chat` when its chat drawer is open (ADR 023).
const threadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/threads/$threadId",
  validateSearch: (
    search: Record<string, unknown>,
  ): { message?: string | undefined; quest?: string | undefined; task?: string | undefined } & WorkbenchSearch => ({
    message: typeof search.message === "string" ? search.message : undefined,
    quest: typeof search.quest === "string" ? search.quest : undefined,
    task: typeof search.task === "string" ? search.task : undefined,
    bench: typeof search.bench === "string" ? search.bench : undefined,
    tab: isWorkbenchTab(search.tab) ? search.tab : undefined,
    attempt: typeof search.attempt === "string" ? search.attempt : undefined,
    file: typeof search.file === "string" ? search.file : undefined,
    chat: search.chat === "open" ? "open" : undefined,
  }),
  component: function ThreadPage() {
    const params = threadRoute.useParams();
    const { message, quest, task, bench, tab, attempt, file, chat } = threadRoute.useSearch();
    return (
      <HobsLayout
        hobId={AgentId.make(params.hobId)}
        threadId={ThreadId.make(params.threadId)}
        focusMessageId={message}
        taskId={task === undefined ? undefined : TaskId.make(task)}
        questId={quest === undefined ? undefined : TaskId.make(quest)}
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

// A hob just summoned, on its own stage with three first questions. A reload keeps it.
const arrivedRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "hobs/$hobId/arrived",
  beforeLoad: ({ context }) => context.queryClient.ensureQueryData(agentsQuery),
  component: function ArrivedRoute() {
    const params = arrivedRoute.useParams();
    return <ArrivedPage hobId={AgentId.make(params.hobId)} />;
  },
});

// Summon names the new hob apart from the hobs already there, so it loads them first. `?step=` is
// the step on screen, so Back and a reload keep it; the first step needs none.
const summonRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "summon",
  validateSearch: (search: Record<string, unknown>): { step?: SummonStep | undefined } => {
    const step = parseStep(search.step);
    return { step: step === "role" ? undefined : step };
  },
  beforeLoad: ({ context }) => context.queryClient.ensureQueryData(agentsQuery),
  component: function SummonRoute() {
    const { step } = summonRoute.useSearch();
    const navigate = summonRoute.useNavigate();
    return (
      <Summon
        step={step ?? "role"}
        onStep={(next) => void navigate({ search: { step: next === "role" ? undefined : next } })}
      />
    );
  },
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
// Settings opens on its overview; each section has its own address, such as `/settings/devices`.
const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings",
  component: () => <SettingsPage section={null} />,
});
const settingsSectionRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings/$section",
  // An unknown section opens the overview rather than an empty page.
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) throw redirect({ to: "/settings" });
  },
  // `?tab=charms` opens Connections on its Charms tab.
  validateSearch: (search: Record<string, unknown>): { tab?: ConnectionsTab | undefined } => ({
    tab: isConnectionsTab(search.tab) && search.tab !== "ai" ? search.tab : undefined,
  }),
  component: function SettingsSectionPage() {
    const { section } = settingsSectionRoute.useParams();
    const { tab } = settingsSectionRoute.useSearch();
    return <SettingsPage section={isSettingsSection(section) ? section : null} tab={tab ?? "ai"} />;
  },
});
// The Archive: archived chats across every hob and retired hobs (CH-009, AG-006). Its pages share
// one toast, so a Restore made in a chat still offers Undo on the list it goes back to.
const archiveRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "archive",
  component: () => (
    <ArchiveNotices>
      <Outlet />
    </ArchiveNotices>
  ),
});

// `?tab=hobs` opens Retired hobs and `?hob=` narrows the archived chats to one hob.
const archiveListRoute = createRoute({
  getParentRoute: () => archiveRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): { tab?: ArchiveTab | undefined; hob?: string | undefined } => ({
    tab: isArchiveTab(search.tab) && search.tab !== "chats" ? search.tab : undefined,
    hob: typeof search.hob === "string" ? search.hob : undefined,
  }),
  component: function Archive() {
    const { tab, hob } = archiveListRoute.useSearch();
    return <ArchivePage tab={tab ?? "chats"} hobId={hob === undefined ? undefined : AgentId.make(hob)} />;
  },
});

// An archived chat, read-only, with Restore.
const archiveChatRoute = createRoute({
  getParentRoute: () => archiveRoute,
  path: "chats/$hobId/$threadId",
  component: function ArchiveChat() {
    const params = archiveChatRoute.useParams();
    return <ArchivedChatPage hobId={AgentId.make(params.hobId)} threadId={ThreadId.make(params.threadId)} />;
  },
});

// A retired hob and its chats, read-only.
const retiredHobRoute = createRoute({
  getParentRoute: () => archiveRoute,
  path: "hobs/$hobId",
  component: function RetiredHob() {
    const params = retiredHobRoute.useParams();
    return <RetiredHobPage hobId={AgentId.make(params.hobId)} />;
  },
});

const retiredChatRoute = createRoute({
  getParentRoute: () => archiveRoute,
  path: "hobs/$hobId/$threadId",
  component: function RetiredChat() {
    const params = retiredChatRoute.useParams();
    return <RetiredChatPage hobId={AgentId.make(params.hobId)} threadId={ThreadId.make(params.threadId)} />;
  },
});

// Settings › Archived hobs is now the Archive's Retired hobs tab.
const archivedRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings/archived",
  beforeLoad: () => {
    throw redirect({ to: "/archive", search: { tab: "hobs" }, replace: true });
  },
});

// A retired hob's old addresses lead to its page and chats in the Archive.
const archivedHobRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings/archived/$hobId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/archive/hobs/$hobId", params: { hobId: params.hobId }, replace: true });
  },
});

const archivedThreadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "settings/archived/$hobId/threads/$threadId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/archive/hobs/$hobId/$threadId",
      params: { hobId: params.hobId, threadId: params.threadId },
      replace: true,
    });
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
    arrivedRoute,
    inboxRoute,
    usageRoute,
    settingsRoute,
    settingsSectionRoute,
    archiveRoute.addChildren([archiveListRoute, archiveChatRoute, retiredHobRoute, retiredChatRoute]),
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
