import { Badge } from "@hobbots/ui/components/badge";
import { PixelArt } from "@hobbots/ui/components/pixel-art";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { connectionBridge } from "../api/connected-desktop.ts";
import { setupQuery } from "../api/setup.ts";
import { ICONS, type IconName, iconPalette } from "../art/icons.ts";
import { BackupSettings } from "./backup/backup-settings.tsx";
import { messages as backupMessages } from "./backup/messages.ts";
import { ConnectedHubSettings } from "./devices/connected-hub.tsx";
import { DeviceList } from "./devices/device-list.tsx";
import { DiagnosticsSettings } from "./diagnostics/diagnostics-settings.tsx";
import { messages as diagnosticsMessages } from "./diagnostics/messages.ts";
import { ExportSettings } from "./export/export-settings.tsx";
import { messages as exportMessages } from "./export/messages.ts";
import { GeneralSettings } from "./general-settings.tsx";
import { GitHubSettings } from "./github-settings.tsx";
import { messages } from "./messages.ts";
import { WaitingDevices } from "./pairing/waiting-devices.tsx";
import { RemoteAccessSettings } from "./remote-access-settings.tsx";
import { FolderPicker, PresetPicker } from "./safety-and-folders.tsx";
import { AboutSettings } from "./settings/about-settings.tsx";
import { messages as settingsMessages } from "./settings/messages.ts";
import { NotificationSettings } from "./settings/notification-settings.tsx";
import { ProviderCard } from "./settings/provider-card.tsx";
import { ReduceMotionRow } from "./settings/reduce-motion.tsx";
import { StandingRuleSettings } from "./standing-rules/standing-rules.tsx";

/**
 * A section's page: its header, then its content. `actions` sit at the end of the title row, such
 * as a period picker; they wrap below the title when the page is narrow.
 */
export function Page({
  icon,
  title,
  intro,
  actions,
  children,
}: {
  icon: IconName;
  title: string;
  intro: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-9 py-8">
      <header className="flex flex-wrap items-center gap-3.5">
        <PixelArt rows={ICONS[icon]} palette={iconPalette(true)} size={40} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="m-0 font-heading text-[28px] font-bold text-moonlight">{title}</h1>
          <p className="m-0 text-text-secondary">{intro}</p>
        </div>
        {actions !== undefined && <div className="flex flex-none items-center gap-2">{actions}</div>}
      </header>
      {children}
    </main>
  );
}

function Panel({
  label,
  id,
  children,
  className,
}: {
  label: string;
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className={cn("cut flex max-w-[760px] flex-col gap-3 bg-panel px-[18px] py-4", className)}
    >
      <span className="lbl text-moonlight">{label}</span>
      {children}
    </section>
  );
}

// Providers from the Hobbots design. Only Claude Code and Codex are wired in this build.
const LATER_PROVIDERS = [
  { name: "Gemini", mark: "G", tile: "bg-provider-gemini" },
  { name: "Grok", mark: "X", tile: "bg-provider-grok" },
  { name: "Local models (Ollama)", mark: "L", tile: "bg-provider-local" },
  { name: "Any OpenAI-compatible key", mark: "+", tile: "bg-provider-other" },
];

/** Settings › Permissions: the safety preset and the folders hobs may work in, as chosen during setup, and the standing rules. */
function PermissionSettings() {
  const setup = useQuery(setupQuery);
  if (setup.isError) {
    return <p className="m-0 text-sm text-rose">Hobbots could not read your permissions. Try again in a moment.</p>;
  }
  if (!setup.data) return null;
  return (
    <>
      <p className="m-0 text-text-secondary">
        How much hobs ask first, and the folders every hob can work in. You can make one hob more careful, or give it
        folders of its own, from its profile.
      </p>
      <PresetPicker label="Safety preset" value={setup.data.safetyPreset} />
      <span className="lbl pt-2 text-label">Folders hobs may open</span>
      {setup.data.approvedFolders.length === 0 && <p className="m-0 text-sm text-text-secondary">No folders yet.</p>}
      <FolderPicker folders={setup.data.approvedFolders} />
      <StandingRuleSettings />
    </>
  );
}

export function SettingsPage() {
  return (
    <Page icon="Settings" title="Settings" intro="How Hobbots starts, AI providers, devices, backups and diagnostics.">
      <Panel label={settingsMessages.thisApp.heading} id="this-app">
        <span className="lbl text-label">{settingsMessages.thisApp.starts}</span>
        <GeneralSettings />
        <ReduceMotionRow />
        <span className="lbl pt-2 text-label">{settingsMessages.thisApp.notifications}</span>
        <NotificationSettings />
      </Panel>
      <Panel label="Permissions">
        <PermissionSettings />
      </Panel>
      <Panel label="AI providers" id="ai-providers">
        <ProviderCard runtime="claude-code" />
        <ProviderCard runtime="codex" />
        <div className="flex flex-col">
          {LATER_PROVIDERS.map((p) => (
            <ProviderRow key={p.name} name={p.name} mark={p.mark} tile={p.tile}>
              <Badge variant="later">Later</Badge>
            </ProviderRow>
          ))}
        </div>
      </Panel>
      <Panel label={messages.github.heading} id="charms">
        <p className="m-0 text-text-secondary">{messages.github.intro}</p>
        <GitHubSettings />
      </Panel>
      <Panel label={backupMessages.heading} id="backup">
        <BackupSettings />
      </Panel>
      <Panel label={messages.remoteAccess.heading} id="devices">
        {/* A connected desktop shows the hub it uses in place of the hub's own network settings (ADR 025). */}
        {connectionBridge ? <ConnectedHubSettings bridge={connectionBridge} /> : <RemoteAccessSettings />}
        <WaitingDevices />
        <DeviceList />
      </Panel>
      <Panel label={exportMessages.heading} id="export">
        <ExportSettings />
      </Panel>
      <Panel label={diagnosticsMessages.heading} id="diagnostics">
        <DiagnosticsSettings />
      </Panel>
      <Panel label="Archived hobs">
        <p className="m-0 text-text-secondary">
          Retired hobs and their chats live in the Archive, where you can read them.
        </p>
        <Link to="/archive" search={{ tab: "hobs" }} className="self-start text-sm text-link underline">
          Open the Archive
        </Link>
      </Panel>
      <Panel label={settingsMessages.about.heading} id="about">
        <AboutSettings />
      </Panel>
    </Page>
  );
}

function ProviderRow({
  name,
  mark,
  tile,
  children,
}: {
  name: string;
  mark: string;
  /** The tile color, as a Tailwind class. */
  tile: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 border-b-2 border-line py-2.5">
      <span aria-hidden className={cn("cut grid size-[30px] place-items-center font-bold text-ground", tile)}>
        {mark}
      </span>
      <span className="flex-1">{name}</span>
      {children}
    </div>
  );
}
