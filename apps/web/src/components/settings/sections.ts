import { Schema } from "effect";
import { messages } from "./messages.ts";

/** The sections of Settings after the overview, in the order the section list shows them. */
export const SETTINGS_SECTIONS = ["app", "safety", "web", "changes", "connections", "devices", "data", "help"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const isSettingsSection = (value: unknown): value is SettingsSection =>
  SETTINGS_SECTIONS.some((section) => section === value);

/** The tabs of Settings › Connections: the AI hobs think with, and the Charms they use. */
const CONNECTIONS_TABS = ["ai", "charms"] as const;

export const ConnectionsTab = Schema.Literals(CONNECTIONS_TABS);
export type ConnectionsTab = typeof ConnectionsTab.Type;

export const isConnectionsTab = Schema.is(ConnectionsTab);

/** A section's name, as the section list and its heading say it. */
export const sectionName = (section: SettingsSection): string => messages.sections[section].name;

/** One setting that Find a setting can open: its name, other words for it, and its section. */
interface SettingEntry {
  readonly label: string;
  readonly words: ReadonlyArray<string>;
  readonly section: SettingsSection;
  /** The Connections tab it sits on, when not the first. */
  readonly tab?: ConnectionsTab;
}

const INDEX: ReadonlyArray<SettingEntry> = messages.find.entries;

/** How many settings Find a setting shows at most. */
const MOST_HITS = 6;

/**
 * The settings whose name or other words hold the query, so "tailscale" finds remote access and
 * "permissions" finds how careful hobs are. Empty for an empty query.
 */
export const findSettings = (query: string): ReadonlyArray<SettingEntry> => {
  const wanted = query.trim().toLocaleLowerCase();
  if (wanted === "") return [];
  return INDEX.filter((entry) =>
    [entry.label, ...entry.words].some((word) => word.toLocaleLowerCase().includes(wanted)),
  ).slice(0, MOST_HITS);
};
