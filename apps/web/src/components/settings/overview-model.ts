import type { BackupState, GitHubStatus } from "@hobbots/api";
import type { RemoteAccessStatus, RuntimeHealth, RuntimeKind, SafetyPreset } from "@hobbots/domain";
import { runtimeProblem, signInProblem } from "../../api/runtime-health.ts";
import { presetInfo } from "../../api/safety.ts";
import { formatAgo, formatList } from "../../lib/format.ts";
import { PROVIDER_NAMES, PROVIDERS } from "../../lib/providers.ts";
import type { Theme } from "../../lib/theme.ts";
import { messages } from "./messages.ts";
import type { SettingsSection } from "./sections.ts";

const copy = messages.overview;

/** How an area stands: working, off by choice, busy, or broken and in need of a fix. */
export type AreaTone = "ok" | "off" | "busy" | "broken" | "plain";

/** One card on the overview: an area of Hobbots, how it stands, and the section that changes it. */
export interface OverviewCard {
  readonly id: "ai" | "safety" | "github" | "devices" | "backups" | "appearance";
  readonly section: SettingsSection;
  /** The Connections tab the card opens, when not the first. */
  readonly tab?: "charms";
  readonly tone: AreaTone;
  readonly title: string;
  readonly state: string;
  readonly hint: string;
}

/**
 * Something broken, which rises above the cards with its fix. A provider names its runtime, so the
 * overview can show that provider's own fix and Check again.
 */
export type OverviewProblem =
  | { readonly kind: "provider"; readonly runtime: RuntimeKind; readonly title: string }
  | { readonly kind: "devices"; readonly title: string; readonly body: string }
  | { readonly kind: "backup"; readonly title: string; readonly body: string };

/** What the overview reads; anything still loading is undefined. */
export interface OverviewInput {
  readonly runtimes: ReadonlyArray<RuntimeHealth> | undefined;
  readonly connected: ReadonlyArray<RuntimeKind> | undefined;
  readonly preset: SafetyPreset | undefined;
  readonly github: GitHubStatus | undefined;
  /** Null on a connected desktop, whose hub sets remote access. */
  readonly remote: RemoteAccessStatus | null | undefined;
  /** Devices allowed besides the hub's own window. */
  readonly otherDevices: number | undefined;
  readonly backup: BackupState | undefined;
  readonly theme: Theme;
  readonly now?: Date;
}

export interface Overview {
  readonly cards: ReadonlyArray<OverviewCard>;
  readonly problems: ReadonlyArray<OverviewProblem>;
  /** The sections that hold something broken, which the section list marks. */
  readonly flagged: ReadonlySet<SettingsSection>;
}

/** What stops a provider from thinking, in a few words, or null when nothing does. */
export const providerState = (health: RuntimeHealth | undefined): string | null => {
  const problem = signInProblem(health) ?? runtimeProblem(health);
  return problem === null ? null : copy.ai.problem[problem];
};

const aiArea = (input: OverviewInput): { card: OverviewCard; problems: ReadonlyArray<OverviewProblem> } => {
  const connected = PROVIDERS.filter((runtime) => input.connected?.includes(runtime));
  const base = { id: "ai", section: "connections", title: copy.ai.title } as const;
  if (connected.length === 0) {
    return { card: { ...base, tone: "off", state: copy.ai.none, hint: copy.ai.noneHint }, problems: [] };
  }
  const health = (runtime: RuntimeKind) => input.runtimes?.find((entry) => entry.runtime === runtime);
  const broken = connected.flatMap((runtime) => {
    const state = providerState(health(runtime));
    return state === null ? [] : [{ runtime, state }];
  });
  const problems = broken.map(
    ({ runtime, state }): OverviewProblem => ({
      kind: "provider",
      runtime,
      title: copy.ai.fixTitle({ name: PROVIDER_NAMES[runtime], state }),
    }),
  );
  const hint = copy.ai.thinkWith({ names: formatList(connected.map((runtime) => PROVIDER_NAMES[runtime])) });
  const first = broken[0];
  if (first !== undefined) return { card: { ...base, tone: "broken", state: first.state, hint }, problems };
  if (input.runtimes === undefined)
    return { card: { ...base, tone: "plain", state: copy.ai.checking, hint }, problems };
  return { card: { ...base, tone: "ok", state: copy.ai.ready, hint }, problems };
};

const safetyCard = (preset: SafetyPreset | undefined): OverviewCard => {
  const info = presetInfo(preset ?? "balanced");
  return {
    id: "safety",
    section: "safety",
    tone: "plain",
    title: copy.safety.title,
    state: info.label,
    hint: info.note,
  };
};

const githubCard = (status: GitHubStatus | undefined): OverviewCard => {
  const base = { id: "github", section: "connections", tab: "charms", title: copy.github.title } as const;
  switch (status?._tag) {
    case "Connected":
      return {
        ...base,
        tone: "ok",
        state: copy.github.connected,
        hint: copy.github.connectedAs({ login: status.account.login }),
      };
    case "Environment":
      return { ...base, tone: "ok", state: copy.github.environment, hint: copy.github.environmentHint };
    case "Connecting":
      return { ...base, tone: "busy", state: copy.github.connecting, hint: copy.github.connectingHint };
    default:
      return { ...base, tone: "off", state: copy.github.off, hint: copy.github.offHint };
  }
};

/** Remote access is on, not paused, yet the hub listens on no tailnet address or not all of them. */
const unreachable = (remote: RemoteAccessStatus) =>
  remote.enabled &&
  !remote.paused &&
  remote.problem !== null &&
  remote.problem !== "off" &&
  remote.problem !== "paused";

const devicesArea = (input: OverviewInput): { card: OverviewCard; problems: ReadonlyArray<OverviewProblem> } => {
  const base = { id: "devices", section: "devices", title: copy.devices.title } as const;
  const { remote } = input;
  if (remote === null) {
    return {
      card: { ...base, tone: "plain", state: copy.devices.connectedDesktop, hint: copy.devices.connectedDesktopHint },
      problems: [],
    };
  }
  if (remote === undefined || !remote.enabled) {
    return { card: { ...base, tone: "off", state: copy.devices.off, hint: copy.devices.offHint }, problems: [] };
  }
  if (remote.paused) {
    return { card: { ...base, tone: "busy", state: copy.devices.paused, hint: copy.devices.pausedHint }, problems: [] };
  }
  if (unreachable(remote)) {
    return {
      card: { ...base, tone: "broken", state: copy.devices.cannotReach, hint: copy.devices.onHint },
      problems: [{ kind: "devices", title: copy.devices.fixTitle, body: copy.devices.fixBody }],
    };
  }
  return {
    card: {
      ...base,
      tone: "ok",
      state: copy.devices.on({ count: input.otherDevices ?? 0 }),
      hint: copy.devices.onHint,
    },
    problems: [],
  };
};

const backupArea = (
  state: BackupState | undefined,
  now: Date,
): { card: OverviewCard; problems: ReadonlyArray<OverviewProblem> } => {
  const base = { id: "backups", section: "data", title: copy.backups.title } as const;
  switch (state?._tag) {
    case "Waiting":
    case "Copying":
      return {
        card: { ...base, tone: "busy", state: copy.backups.running, hint: copy.backups.runningHint },
        problems: [],
      };
    case "Done":
      return {
        card: {
          ...base,
          tone: "ok",
          state: copy.backups.done({ when: formatAgo(state.finishedAt, now) }),
          hint: copy.backups.doneHint,
        },
        problems: [],
      };
    case "Failed":
      return {
        card: { ...base, tone: "broken", state: copy.backups.failed, hint: state.reason },
        problems: [{ kind: "backup", title: copy.backups.fixTitle, body: state.reason }],
      };
    default:
      return { card: { ...base, tone: "plain", state: copy.backups.idle, hint: copy.backups.idleHint }, problems: [] };
  }
};

const appearanceCard = (theme: Theme): OverviewCard => {
  const look = theme.startsWith("workshop") ? copy.appearance.looks.workshop : copy.appearance.looks.lamplight;
  const mode =
    theme === "lamplight-dusk" || theme === "workshop-night" ? copy.appearance.modes.dark : copy.appearance.modes.light;
  return {
    id: "appearance",
    section: "app",
    tone: "plain",
    title: copy.appearance.title,
    state: copy.appearance.state({ look, mode }),
    hint: copy.appearance.hint,
  };
};

/**
 * The overview: one card per area, in the design's order, and whatever is broken first, so
 * "is everything OK?" has its answer at the top. Only durable hub records decide a state (STD-UI-008).
 */
export const overviewOf = (input: OverviewInput): Overview => {
  const ai = aiArea(input);
  const devices = devicesArea(input);
  const backup = backupArea(input.backup, input.now ?? new Date());
  const cards = [
    ai.card,
    safetyCard(input.preset),
    githubCard(input.github),
    devices.card,
    backup.card,
    appearanceCard(input.theme),
  ];
  const problems = [...ai.problems, ...devices.problems, ...backup.problems];
  return {
    cards,
    problems,
    flagged: new Set(cards.filter((card) => card.tone === "broken").map((card) => card.section)),
  };
};

/** The overview's title: everything works, or how many things need fixing. */
export const overviewTitle = (problems: number): { readonly title: string; readonly line: string } => {
  if (problems === 0) return { title: copy.allWell, line: copy.allWellLine };
  return { title: problems === 1 ? copy.oneToFix : copy.someToFix({ count: problems }), line: copy.toFixLine };
};
