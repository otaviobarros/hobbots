import { Badge } from "@hobbots/ui/components/badge";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { connectionBridge } from "../../api/connected-desktop.ts";
import { setupQuery } from "../../api/setup.ts";
import { BackupSettings } from "../backup/backup-settings.tsx";
import { messages as backupMessages } from "../backup/messages.ts";
import { ConnectedHubSettings } from "../devices/connected-hub.tsx";
import { DeviceList } from "../devices/device-list.tsx";
import { DiagnosticsSettings } from "../diagnostics/diagnostics-settings.tsx";
import { messages as diagnosticsMessages } from "../diagnostics/messages.ts";
import { ExportSettings } from "../export/export-settings.tsx";
import { messages as exportMessages } from "../export/messages.ts";
import { GeneralSettings } from "../general-settings.tsx";
import { GitHubSettings } from "../github-settings.tsx";
import { messages as sharedMessages } from "../messages.ts";
import { WaitingDevices } from "../pairing/waiting-devices.tsx";
import { RemoteAccessSettings } from "../remote-access-settings.tsx";
import { FolderPicker, PresetPicker } from "../safety-and-folders.tsx";
import { StandingRuleSettings } from "../standing-rules/standing-rules.tsx";
import { AboutSettings } from "./about-settings.tsx";
import { messages } from "./messages.ts";
import { NotificationSettings } from "./notification-settings.tsx";
import { ProviderCard } from "./provider-card.tsx";
import { ReduceMotionRow } from "./reduce-motion.tsx";
import type { SettingsSection } from "./sections.ts";

const copy = messages.groups;

/** One group of a section: its label, then its settings. */
function SettingsGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label} className={cn("flex flex-col gap-3", className)}>
      <h3 className="lbl m-0 text-label">{label}</h3>
      {children}
    </section>
  );
}

/** The open section's settings, below its heading. */
export function SectionContent({ section }: { section: SettingsSection }) {
  switch (section) {
    case "app":
      return <ThisApp />;
    case "safety":
      return <Safety />;
    case "connections":
      return <Connections />;
    case "devices":
      return <Devices />;
    case "data":
      return <YourData />;
    case "help":
      return <HelpAndAbout />;
  }
}

function ThisApp() {
  return (
    <>
      <SettingsGroup label={messages.thisApp.starts}>
        <GeneralSettings />
        <ReduceMotionRow />
      </SettingsGroup>
      <SettingsGroup label={messages.thisApp.notifications}>
        <NotificationSettings />
      </SettingsGroup>
    </>
  );
}

/** How careful hobs are, the folders every hob can work in, as chosen during setup, and the standing rules. */
function Safety() {
  const setup = useQuery(setupQuery);
  if (setup.isError) return <p className="m-0 text-sm text-rose">{copy.safetyFailed}</p>;
  if (!setup.data) return null;
  return (
    <>
      <SettingsGroup label={copy.howCareful}>
        <PresetPicker label={copy.howCareful} value={setup.data.safetyPreset} />
      </SettingsGroup>
      <SettingsGroup label={copy.folders}>
        {setup.data.approvedFolders.length === 0 && <p className="m-0 text-sm text-text-secondary">{copy.noFolders}</p>}
        <FolderPicker folders={setup.data.approvedFolders} />
      </SettingsGroup>
      <StandingRuleSettings />
    </>
  );
}

// Providers from the Hobbots design. Only Claude Code and Codex are wired in this build.
const LATER_PROVIDERS = [
  { name: "Gemini", mark: "G", tile: "bg-provider-gemini" },
  { name: "Grok", mark: "X", tile: "bg-provider-grok" },
  { name: "Local models (Ollama)", mark: "L", tile: "bg-provider-local" },
  { name: "Any OpenAI-compatible key", mark: "+", tile: "bg-provider-other" },
];

function Connections() {
  return (
    <>
      <SettingsGroup label={messages.providers.heading}>
        <ProviderCard runtime="claude-code" />
        <ProviderCard runtime="codex" />
        <div className="flex flex-col">
          {LATER_PROVIDERS.map((provider) => (
            <div key={provider.name} className="flex items-center gap-3.5 border-b border-line py-2.5">
              <span
                aria-hidden
                className={cn(
                  "grid size-[30px] place-items-center rounded-tile font-bold text-provider-ink",
                  provider.tile,
                )}
              >
                {provider.mark}
              </span>
              <span className="flex-1">{provider.name}</span>
              <Badge variant="later">{copy.later}</Badge>
            </div>
          ))}
        </div>
      </SettingsGroup>
      <SettingsGroup label={sharedMessages.github.heading}>
        <p className="m-0 text-text-secondary">{sharedMessages.github.intro}</p>
        <GitHubSettings />
      </SettingsGroup>
    </>
  );
}

function Devices() {
  return (
    <>
      {/* A connected desktop shows the hub it uses in place of the hub's own network settings (ADR 025). */}
      {connectionBridge ? <ConnectedHubSettings bridge={connectionBridge} /> : <RemoteAccessSettings />}
      <WaitingDevices />
      <DeviceList />
    </>
  );
}

function YourData() {
  return (
    <>
      <SettingsGroup label={backupMessages.heading}>
        <BackupSettings />
      </SettingsGroup>
      <SettingsGroup label={exportMessages.heading}>
        <ExportSettings />
      </SettingsGroup>
      <SettingsGroup label={copy.retiredHobs}>
        <p className="m-0 text-text-secondary">{copy.retiredHobsBody}</p>
        <Link to="/archive" search={{ tab: "hobs" }} className="self-start text-sm text-link underline">
          {copy.openArchive}
        </Link>
      </SettingsGroup>
    </>
  );
}

function HelpAndAbout() {
  return (
    <>
      <SettingsGroup label={diagnosticsMessages.heading}>
        <DiagnosticsSettings />
      </SettingsGroup>
      <AboutSettings />
    </>
  );
}
