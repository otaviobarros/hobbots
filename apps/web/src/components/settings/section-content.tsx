import { Link } from "@tanstack/react-router";
import { connectionBridge } from "../../api/connected-desktop.ts";
import { BackupSettings } from "../backup/backup-settings.tsx";
import { messages as backupMessages } from "../backup/messages.ts";
import { ConnectedHubSettings } from "../devices/connected-hub.tsx";
import { DeviceList } from "../devices/device-list.tsx";
import { DiagnosticsSettings } from "../diagnostics/diagnostics-settings.tsx";
import { messages as diagnosticsMessages } from "../diagnostics/messages.ts";
import { ExportSettings } from "../export/export-settings.tsx";
import { messages as exportMessages } from "../export/messages.ts";
import { GeneralSettings } from "../general-settings.tsx";
import { WaitingDevices } from "../pairing/waiting-devices.tsx";
import { RemoteAccessSettings } from "../remote-access-settings.tsx";
import { AboutSettings } from "./about-settings.tsx";
import { ConnectionsSection } from "./connections-section.tsx";
import { messages } from "./messages.ts";
import { NotificationSettings } from "./notification-settings.tsx";
import { ReduceMotionRow } from "./reduce-motion.tsx";
import { SafetySection } from "./safety-section.tsx";
import type { ConnectionsTab, SettingsSection } from "./sections.ts";
import { SettingsGroup } from "./settings-group.tsx";

const copy = messages.groups;

/** The open section's settings, below its heading. */
export function SectionContent({ section, tab }: { section: SettingsSection; tab: ConnectionsTab }) {
  switch (section) {
    case "app":
      return <ThisApp />;
    case "safety":
      return <SafetySection />;
    case "connections":
      return <ConnectionsSection tab={tab} />;
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

function Devices() {
  return (
    <>
      {/* A connected desktop shows the hub it uses in place of the hub's own network settings (ADR 025). */}
      {/* A device asking to join comes first: it is waiting on you. */}
      <WaitingDevices />
      {connectionBridge ? <ConnectedHubSettings bridge={connectionBridge} /> : <RemoteAccessSettings />}
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
