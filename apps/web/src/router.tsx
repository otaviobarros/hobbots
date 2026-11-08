import { AgentId, AttemptId, HistoryFilter, MemoryKind, MemoryScopeKey, TaskId, ThreadId } from "@hobbots/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { keptDraftOrStored } from "./api/first-hob.ts";
import { needsPairing } from "./api/pairing.ts";
import { agentsQuery } from "./api/queries.ts";
import { opensWelcome, readSetup, setupDone } from "./api/setup.ts";
import { ArchiveTab } from "./components/archive-page/archive-model.ts";
import { ArchiveNotices } from "./components/archive-page/archive-notices.tsx";
import { ArchivePage } from "./components/archive-page/archive-page.tsx";
import { ArchivedChatPage, RetiredChatPage, RetiredHobPage } from "./components/archive-page/archive-read.tsx";
import { HobPage } from "./components/hob-page/hob-page.tsx";
import { HobPageTab } from "./components/hob-page/hob-page-model.ts";
import { HobProfile, ProfileTabName } from "./components/hob-profile/hob-profile.tsx";
import { HobsLayout } from "./components/hobs-page/hobs-layout.tsx";
import { HobsPage } from "./components/hobs-page/hobs-page.tsx";
import { HobFilter } from "./components/hobs-page/hobs-page-model.ts";
import { Home } from "./components/home/home.tsx";
import { InboxTab } from "./components/inbox/inbox-items.ts";
import { InboxPage } from "./components/inbox/inbox-page.tsx";
import { ChangeFilter } from "./components/memory/memory-model.ts";
import { MemoryPage } from "./components/memory/memory-page.tsx";
import { OnboardingFirstHob } from "./components/onboarding/onboarding-first-hob.tsx";
import { OnboardingProviders } from "./components/onboarding/onboarding-providers.tsx";
import { OnboardingFolders, OnboardingSafety } from "./components/onboarding/onboarding-safety.tsx";
import { OnboardingReady } from "./components/onboarding/onboarding-summon.tsx";
import { Welcome } from "./components/onboarding/welcome.tsx";
import { WhereHobbotsRuns } from "./components/onboarding/where-hobbots-runs.tsx";
import { PairingScreen } from "./components/pairing/pairing-screen.tsx";
import { RoomSearch } from "./components/quest-room/room-search.ts";
import { SetupRemoteAccess } from "./components/remote-access/setup-remote-access.tsx";
import { AppError, PageError, ScreenError } from "./components/route-error/route-error.tsx";
import { ConnectionsTab, isSettingsSection } from "./components/settings/sections.ts";
import { SettingsPage } from "./components/settings/settings-page.tsx";
import { AppShell, AppWindow } from "./components/shell/app-shell.tsx";
import { ImportFrom, SkillTab } from "./components/skills/skills-model.ts";
import { SkillsPage } from "./components/skills/skills-page.tsx";
import { ArrivedPage, ArrivedWaiting } from "./components/summon/arrived.tsx";
import { Summon } from "./components/summon/summon.tsx";
import { SummonStep } from "./components/summon/summon-model.ts";
import { UsagePage } from "./components/usage/usage-page.tsx";
import { SearchText, searchParam } from "./lib/search-params.ts";
import { UsageDays, UsageSplit } from "./lib/usage.ts";

const PAIR_PATH = "/pair";

// A browser without a device on the hub asks for one before anything else (ADR 021).
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async ({ location, context }) => {
    if (location.pathname !== PAIR_PATH && (await needsPairing(context.queryClient))) {
      throw redirect({ to: PAIR_PATH });
    }
  },
  component: AppWindow,
  errorComponent: AppError,
});

// The pairing screen: ask once, wait with the matching code, and open Hobbots once allowed.
const pairRoute = createRoute({
  getParentRoute: () => rootRoute,
  errorComponent: (props) => <ScreenError error={props.error} />,
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
  errorComponent: (props) => <ScreenError error={props.error} />,
  path: "welcome",
  beforeLoad: leaveSetupWhenDone,
  component: Welcome,
});

const setupWhereRoute = createRoute({
  getParentRoute: () => rootRoute,
  errorComponent: (props) => <ScreenError error={props.error} way="welcome" />,
  path: "setup/where",
  beforeLoad: leaveSetupWhenDone,
  component: WhereHobbotsRuns,
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  errorComponent: (props) => <ScreenError error={props.error} way="welcome" />,
  path: "setup/providers",
  beforeLoad: leaveSetupWhenDone,
  component: OnboardingProviders,
});

const firstHobRoute = createRoute({
  getParentRoute: () => rootRoute,
  errorComponent: (props) => <ScreenError error={props.error} way="welcome" />,
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
  errorComponent: (props) => <ScreenError error={props.error} way="welcome" />,
  path: "setup/safety",
  beforeLoad: afterFirstHob,
  component: OnboardingSafety,
});

const foldersRoute = createRoute({
  getParentRoute: () => rootRoute,
  errorComponent: (props) => <ScreenError error={props.error} way="welcome" />,
  path: "setup/folders",
  beforeLoad: afterFirstHob,
  component: OnboardingFolders,
});

// After Folders, setup asks whether other devices may use Hobbots too (ADR 021). It can be skipped.
const setupRemoteRoute = createRoute({
  getParentRoute: () => rootRoute,
  errorComponent: (props) => <ScreenError error={props.error} way="welcome" />,
  path: "setup/remote",
  beforeLoad: afterFirstHob,
  component: SetupRemoteAccess,
});

const readyRoute = createRoute({
  getParentRoute: () => rootRoute,
  errorComponent: (props) => <ScreenError error={props.error} way="welcome" />,
  path: "setup/ready",
  beforeLoad: afterFirstHob,
  component: OnboardingReady,
});

// Every page after setup shares the sidebar.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
  errorComponent: (props) => <ScreenError error={props.error} />,
});

// Home is the landing page; each hob is one click away on its own page.
const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  path: "/",
  beforeLoad: async ({ context }) => {
    if (opensWelcome(await readSetup(context.queryClient))) throw redirect({ to: "/welcome" });
  },
  component: Home,
});

// Your hobs: every hob as a card. `?show=` narrows it to the hobs that need you, work or rest.
const hobsRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="home" />,
  path: "hobs",
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ show: searchParam(HobFilter) })),
  component: function YourHobs() {
    const { show } = hobsRoute.useSearch();
    return <HobsPage filter={show ?? "all"} />;
  },
});

// A hob's own page: its hero, its chats and its history. `?tab=history` opens History.
const hobRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  path: "hobs/$hobId",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      tab: searchParam(HobPageTab),
      show: searchParam(HistoryFilter),
      // A link can open the Chats tab already searching, such as from a chat's own search.
      q: searchParam(SearchText),
    }),
  ),
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
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  path: "hobs/$hobId/new",
  component: function NewThreadPage() {
    const params = newThreadRoute.useParams();
    return <HobsLayout hobId={AgentId.make(params.hobId)} />;
  },
});

// A hob's archived threads now live in the Archive, narrowed to that hob (CH-009).
const archivedThreadsRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  path: "hobs/$hobId/archived",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/archive", search: { hob: params.hobId }, replace: true });
  },
});

// `?message=` names a message to scroll to, as a search result does. `?room=` opens the Quest room
// beside the chat on a Task of its Quest, with the lit `lane`, the Workbench `tab` while its dock is
// open, the `attempt` it shows and the `file` a tab shows first (ADR 027).
const threadRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  path: "hobs/$hobId/threads/$threadId",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      message: searchParam(Schema.String),
      ...RoomSearch,
    }),
  ),
  component: function ThreadPage() {
    const params = threadRoute.useParams();
    const { message, room, lane, tab, attempt, file, from, scope } = threadRoute.useSearch();
    return (
      <HobsLayout
        hobId={AgentId.make(params.hobId)}
        threadId={ThreadId.make(params.threadId)}
        focusMessageId={message}
        room={
          room === undefined
            ? undefined
            : {
                taskId: TaskId.make(room),
                lane: lane === undefined ? undefined : TaskId.make(lane),
                tab,
                attemptId: attempt === undefined ? undefined : AttemptId.make(attempt),
                file,
                from: from === undefined ? undefined : AttemptId.make(from),
                taskOnly: scope === "task",
              }
        }
      />
    );
  },
});

// The hob's profile: its instructions, brain, Pause / Wake and Retire.
const profileRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  path: "hobs/$hobId/profile",
  // `?tab=` opens Charms or Permissions, as a hob's Memory tab links to what it may remember.
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ tab: searchParam(ProfileTabName) })),
  component: function ProfilePage() {
    const params = profileRoute.useParams();
    const { tab } = profileRoute.useSearch();
    return <HobProfile key={params.hobId} hobId={AgentId.make(params.hobId)} tab={tab ?? "profile"} />;
  },
});

// A hob just summoned, on its own stage with three first questions. A reload keeps it, and draws
// the stage at once while the hobs are read: the waiting frame shows from the start, not after a delay.
const arrivedRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  pendingComponent: ArrivedWaiting,
  pendingMs: 0,
  pendingMinMs: 0,
  path: "hobs/$hobId/arrived",
  // `?skills=not-given` when the skills picked in Summon were not given yet, which Arrived says.
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ skills: searchParam(Schema.Literal("not-given")) })),
  loader: ({ context }) => context.queryClient.ensureQueryData(agentsQuery),
  component: function ArrivedRoute() {
    const params = arrivedRoute.useParams();
    const search = arrivedRoute.useSearch();
    return <ArrivedPage hobId={AgentId.make(params.hobId)} skillsNotGiven={search.skills === "not-given"} />;
  },
});

// Summon names the new hob apart from the hobs already there, so it loads them first. `?step=` is
// the step on screen, so Back and a reload keep it; the first step needs none.
const summonRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="hobs" />,
  path: "summon",
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ step: searchParam(SummonStep) })),
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
  errorComponent: (props) => <PageError error={props.error} way="home" />,
  path: "inbox",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ tab: searchParam(InboxTab), request: searchParam(Schema.String) }),
  ),
  component: function Inbox() {
    const { tab, request } = inboxRoute.useSearch();
    return <InboxPage tab={tab ?? "needs"} requestId={request} />;
  },
});
// `?days=` picks the period: the last 7 days, or 30. The router reads the number as a number. `?by=quest`
// splits Who used what by quest.
const usageRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="home" />,
  path: "usage",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ days: searchParam(UsageDays), by: searchParam(UsageSplit) }),
  ),
  component: function Usage() {
    const { days, by } = usageRoute.useSearch();
    return <UsagePage days={days === 30 ? "30" : "7"} by={by ?? "hob"} />;
  },
});
// Memory (ADR 028): `?scope=` opens a scope and `&page=` a page in it, `&v=` shows what one version
// changed, `?q=` searches (`&in=` in one scope), `?view=changes` opens What changed and `?view=review`
// To review, with `&item=` the share or finding open there. `&edit=page` opens the page in the
// editor, and `&edit=new` a new page in the scope.
const memoryRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="home" />,
  path: "memory",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      view: searchParam(Schema.Literals(["changes", "review"])),
      item: searchParam(Schema.String),
      scope: searchParam(MemoryScopeKey),
      page: searchParam(Schema.String),
      v: searchParam(Schema.String),
      kind: searchParam(MemoryKind),
      q: searchParam(SearchText),
      in: searchParam(MemoryScopeKey),
      show: searchParam(ChangeFilter),
      edit: searchParam(Schema.Literals(["page", "new"])),
    }),
  ),
  component: function Memory() {
    return <MemoryPage search={memoryRoute.useSearch()} />;
  },
});
// Skills (ADR 029): `?scope=` opens a scope, `?skill=` a skill with `&tab=` its tab, `&file=` a file and
// `&diff=` what a revision changed; `&member=` a skill of a set, by its name in the set; `&edit=skill` opens its editor and `?edit=new` a new skill; `?add=`
// opens Add a skill from Git, a folder, a repository a hob works in (`&item=` its project) or written here; `?export=skills` opens Export skills; `?view=changes`
// What changed and `?view=updates` Updates, with `&item=` the skill whose update is open; `?q=` searches.
const skillsRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="home" />,
  path: "skills",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      scope: searchParam(MemoryScopeKey),
      skill: searchParam(Schema.String),
      member: searchParam(Schema.String),
      tab: searchParam(SkillTab),
      file: searchParam(Schema.String),
      diff: searchParam(Schema.String),
      edit: searchParam(Schema.Literals(["skill", "new"])),
      add: searchParam(ImportFrom),
      export: searchParam(Schema.Literals(["skills"])),
      q: searchParam(SearchText),
      view: searchParam(Schema.Literals(["changes", "review", "updates"])),
      item: searchParam(Schema.String),
      trial: searchParam(Schema.String),
    }),
  ),
  component: function Skills() {
    return <SkillsPage search={skillsRoute.useSearch()} />;
  },
});
// Settings opens on its overview; each section has its own address, such as `/settings/devices`.
const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="home" />,
  path: "settings",
  component: () => <SettingsPage section={null} />,
});
const settingsSectionRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="settings" />,
  path: "settings/$section",
  // An unknown section opens the overview rather than an empty page.
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) throw redirect({ to: "/settings" });
  },
  // `?tab=charms` opens Connections on its Charms tab.
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ tab: searchParam(ConnectionsTab) })),
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
  errorComponent: (props) => <PageError error={props.error} way="home" />,
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
  errorComponent: (props) => <PageError error={props.error} way="home" />,
  path: "/",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ tab: searchParam(ArchiveTab), hob: searchParam(Schema.String) }),
  ),
  component: function Archive() {
    const { tab, hob } = archiveListRoute.useSearch();
    return <ArchivePage tab={tab ?? "chats"} hobId={hob === undefined ? undefined : AgentId.make(hob)} />;
  },
});

// An archived chat, read-only, with Restore. `?message=` opens it on a search match.
const archiveChatRoute = createRoute({
  getParentRoute: () => archiveRoute,
  errorComponent: (props) => <PageError error={props.error} way="archive" />,
  path: "chats/$hobId/$threadId",
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ message: searchParam(Schema.String) })),
  component: function ArchiveChat() {
    const params = archiveChatRoute.useParams();
    const { message } = archiveChatRoute.useSearch();
    return (
      <ArchivedChatPage
        hobId={AgentId.make(params.hobId)}
        threadId={ThreadId.make(params.threadId)}
        focusMessageId={message}
      />
    );
  },
});

// A retired hob and its chats, read-only.
const retiredHobRoute = createRoute({
  getParentRoute: () => archiveRoute,
  errorComponent: (props) => <PageError error={props.error} way="archive" />,
  path: "hobs/$hobId",
  component: function RetiredHob() {
    const params = retiredHobRoute.useParams();
    return <RetiredHobPage hobId={AgentId.make(params.hobId)} />;
  },
});

const retiredChatRoute = createRoute({
  getParentRoute: () => archiveRoute,
  errorComponent: (props) => <PageError error={props.error} way="archive" />,
  path: "hobs/$hobId/$threadId",
  component: function RetiredChat() {
    const params = retiredChatRoute.useParams();
    return <RetiredChatPage hobId={AgentId.make(params.hobId)} threadId={ThreadId.make(params.threadId)} />;
  },
});

// Settings › Archived hobs is now the Archive's Retired hobs tab.
const archivedRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="archive" />,
  path: "settings/archived",
  beforeLoad: () => {
    throw redirect({ to: "/archive", search: { tab: "hobs" }, replace: true });
  },
});

// A retired hob's old addresses lead to its page and chats in the Archive.
const archivedHobRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="archive" />,
  path: "settings/archived/$hobId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/archive/hobs/$hobId", params: { hobId: params.hobId }, replace: true });
  },
});

const archivedThreadRoute = createRoute({
  getParentRoute: () => shellRoute,
  errorComponent: (props) => <PageError error={props.error} way="archive" />,
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
    memoryRoute,
    skillsRoute,
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
    // Anything a route does not catch still gets a way out, never a blank window (STD-REACT-014).
    defaultErrorComponent: (props) => <ScreenError error={props.error} way="home" />,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
